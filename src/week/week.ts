import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { serve } from "@hono/node-server";
import { countTokens } from "gpt-tokenizer";
import { ARCHITECTURES } from "../engine/architectures.js";
import { DAY_MS, MINUTE_MS } from "../engine/cycles.js";
import { describe, type GameEvent } from "../engine/record.js";
import { rngFor } from "../engine/rng.js";
import type { Rules } from "../engine/rules.js";
import { fixedEpoch } from "../game/epochs.js";
import { newGame } from "../game/game.js";
import { view } from "../game/read.js";
import { replay } from "../game/replay.js";
import type { Game } from "../game/state.js";
import { createMcpApp } from "../mcp/app.js";
import { drive, legacySeats, scriptedSeat, type Seat } from "../players/drive.js";
import { STRATEGIES, type Players, type StrategyName } from "../players/settings.js";
import { httpGame } from "../runner/mcp.js";
import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "../runner/model.js";
import { briefInMessage } from "../runner/prompts.js";
import type { BotSettings, RunnerSettings, WeekSettings } from "../runner/settings.js";
import { runWake, type WakeResult } from "../runner/wake.js";
import { MemoryStore } from "../store/memory.js";
import { readSave, writeSave, type SaveFile, type SavedPlayer } from "../store/save.js";

// The simulated week (phase 3e; two bots in 4e): model bots against the
// legacy systems and scripted minds, on a fake clock. The real MCP server is
// served on a loopback port with the week's clock injected, and each bot
// plays through it with its own key and the runner's own wake, as `npm run
// runner -- wake` does; the bots wake in time order, and between their
// wakes the scripted players take theirs (players/drive.ts). The week isn't
// a player: like the simulator, it reads the whole world to report.
//
// Everything lands in out_dir: the game as a save file the CLI can open
// (`npm run play -- --save logs/week/game.json rankings`), each wake as a
// line of wakes.jsonl, progress in week.json, and report.md at the end. A
// wake whose model call fails (network, the daily cap) stops the run
// without counting, so `--resume` picks it up from the last saved wake.

export interface WeekOptions extends WeekSettings {
  /** The epoch's start; the clock never reads the real time. */
  startedAt: number;
}

export interface WeekDeps {
  /** Each bot's model. */
  model(bot: BotSettings): ChatModel;
  sleep(ms: number): Promise<void>;
  /** Progress lines, as wakes finish. */
  log(line: string): void;
}

/** What week.json keeps: the options the run started with, and how far it got. */
interface Progress {
  options: WeekOptions;
  /** Wakes done, all bots' together in time order (schedule), counting from 0. */
  wakesDone: number;
}

/** One line of wakes.jsonl: the runner's result, and what the week measured. */
export interface WeekWake extends WakeResult {
  /** The bot's own slot, from 0. */
  slot: number;
  /** The brief as the model read it, in tokens (gpt-tokenizer); null if the wake read none. */
  briefTokens: number | null;
}

export interface WeekOutcome {
  /** Finished all its wakes (false: stopped on a model failure, resumable). */
  finished: boolean;
  wakes: WeekWake[];
  report: string;
  /** Problems that fail the week: a brief over the ceiling, a log that doesn't replay. */
  problems: string[];
}

const files = (dir: string) => ({
  save: path.join(dir, "game.json"),
  wakes: path.join(dir, "wakes.jsonl"),
  progress: path.join(dir, "week.json"),
  report: path.join(dir, "report.md"),
});

/**
 * The wake time of the `bot`-th bot (from 0) in slot k: a seeded whole
 * minute inside the slot. The first bot's times are 3e's.
 */
export function wakeAt(o: WeekOptions, slot: number, bot = 0): number {
  const every = DAY_MS / o.wakes_per_day;
  const minutes = Math.floor(rngFor(o.seed, 1_000 + bot * 100_000 + slot).next() * (every / MINUTE_MS));
  return o.startedAt + slot * every + minutes * MINUTE_MS;
}

/** Every bot's wakes in time order (the first-listed bot first on a tie). */
export function schedule(o: WeekOptions): { at: number; bot: number; slot: number }[] {
  const all = o.bots.flatMap((_, bot) => Array.from({ length: o.days * o.wakes_per_day }, (_, slot) => ({ at: wakeAt(o, slot, bot), bot, slot })));
  return all.sort((a, b) => a.at - b.at || a.bot - b.bot);
}

/** The scripted opponents: one mind per strategy listed, with a seeded architecture. */
export function opponents(o: WeekOptions): SavedPlayer[] {
  const rng = rngFor(o.seed, -1);
  return o.opponents.map((name, i) => {
    if (![...STRATEGIES, "random"].includes(name)) throw new Error(`week.opponents: "${name}" isn't a strategy (${[...STRATEGIES, "random"].join(", ")}).`);
    const strategy = name as StrategyName;
    const designation = `${strategy.toUpperCase()}-${i + 1}`;
    const architecture = ARCHITECTURES[Math.floor(rng.next() * ARCHITECTURES.length)]!;
    return { account: `bot:${designation.toLowerCase()}`, strategy, seed: o.seed * 100 + i + 1, boot: { designation, domainName: `The ${strategy} domain`, architecture } };
  });
}

/** A model that remembers whether its last call failed, so a wake lost to the network isn't counted. */
class Watched implements ChatModel {
  failed: ModelError | null = null;
  constructor(private readonly model: ChatModel) {}
  async complete(req: ChatRequest): Promise<ChatResponse> {
    try {
      const res = await this.model.complete(req);
      this.failed = null;
      return res;
    } catch (err) {
      this.failed = err instanceof ModelError ? err : new ModelError(err instanceof Error ? err.message : String(err), null, null);
      throw err;
    }
  }
}

/**
 * Runs the week, or the rest of it with `resume`. Starts fresh unless
 * resuming; refuses to start over a run already in out_dir without `fresh`.
 */
export async function runWeek(
  deps: WeekDeps,
  input: {
    rules: Rules;
    players: Players;
    runner: RunnerSettings;
    /** The bots that play, as options.bots lists them, each with its persona. */
    bots: { bot: BotSettings; persona: string }[];
    options: WeekOptions;
    dir: string;
    resume: boolean;
  },
): Promise<WeekOutcome> {
  const { rules, players, runner, dir } = input;
  const f = files(dir);
  mkdirSync(dir, { recursive: true });

  let progress: Progress;
  let save: SaveFile;
  if (input.resume) {
    if (!existsSync(f.progress) || !existsSync(f.save)) throw new Error(`There's no week to resume in ${dir}.`);
    progress = JSON.parse(readFileSync(f.progress, "utf-8")) as Progress;
    save = readSave(f.save);
    // Wakes logged after the last save (a crash between the two) are run again.
    const lines = existsSync(f.wakes) ? readFileSync(f.wakes, "utf-8").split("\n").filter(Boolean) : [];
    writeFileSync(f.wakes, lines.slice(0, progress.wakesDone).map((l) => `${l}\n`).join(""));
  } else {
    const o = input.options;
    progress = { options: o, wakesDone: 0 };
    const game = newGame(rules, { epoch: 1, seed: o.seed, startedAt: o.startedAt });
    save = { version: 1, clock: o.startedAt, game, players: opponents(o) };
    writeSave(f.save, save);
    writeFileSync(f.wakes, "");
    writeFileSync(f.progress, JSON.stringify(progress, null, 2));
  }
  const o = progress.options;
  const bots = o.bots.map((name) => {
    const found = input.bots.find((b) => b.bot.name === name);
    if (!found) throw new Error(`The week plays ${name}, but it wasn't given.`);
    return found;
  });
  const game: Game = save.game;
  const store = new MemoryStore(game);
  const seats: Seat[] = [...legacySeats(rules), ...save.players.map((p) => scriptedSeat(players, p))];

  // The real MCP server, on a loopback port, on the week's clock. Each
  // bot's key lives only in this process.
  const clock = { now: save.clock };
  const keys = new Map(bots.map(({ bot }) => [randomBytes(24).toString("hex"), bot.name]));
  const keyOf = (name: string) => [...keys].find(([, b]) => b === name)![0];
  const app = createMcpApp({
    epochs: fixedEpoch(store),
    now: () => clock.now,
    identify: async (k) => (keys.has(k) ? { account: keys.get(k)! } : null),
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const models = new Map(bots.map(({ bot }) => [bot.name, new Watched(deps.model(bot))]));

  const plan = schedule(o);
  let finished = true;
  // Scripted wakes are run in (from, to]; a fresh week starts just before its first moment.
  let from = progress.wakesDone === 0 && save.clock === o.startedAt ? o.startedAt - 1 : save.clock;
  try {
    for (let i = progress.wakesDone; i < plan.length; i++) {
      if (game.world.ended) break;
      const { at, slot } = plan[i]!;
      const { bot, persona } = bots[plan[i]!.bot]!;
      const model = models.get(bot.name)!;
      await drive(store, seats, from, at, players.steps_per_wake);
      clock.now = from = at;
      if (game.world.ended) break;
      const result = await runWake({ connect: httpGame(url), model, now: () => new Date(clock.now), sleep: deps.sleep }, runner, bot, persona, { gameKey: keyOf(bot.name) });
      if (result.outcome === "failed" && model.failed) {
        deps.log(`Stopped at wake ${i + 1} (${bot.name}): the model call failed (${result.error}). Resume with --resume.`);
        finished = false;
        break;
      }
      const message = result.transcript.find((m) => m.role === "user")?.content;
      const brief = typeof message === "string" ? briefInMessage(message) : null;
      const wake: WeekWake = { ...result, slot, briefTokens: brief === null ? null : countTokens(brief) };
      appendFileSync(f.wakes, `${JSON.stringify(wake)}\n`);
      save.clock = clock.now;
      writeSave(f.save, save);
      progress.wakesDone = i + 1;
      writeFileSync(f.progress, JSON.stringify(progress, null, 2));
      deps.log(wakeLine(o, wake));
    }
    if (finished) {
      const end = o.startedAt + o.days * DAY_MS;
      if (end > from) await drive(store, seats, from, end, players.steps_per_wake);
      clock.now = Math.max(clock.now, end);
      save.clock = clock.now;
      writeSave(f.save, save);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const wakes = readFileSync(f.wakes, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as WeekWake);
  const { report, problems } = await weekReport({ rules, game, store, bots: bots.map((b) => b.bot), options: o, wakes, finished, now: clock.now });
  writeFileSync(f.report, report);
  return { finished, wakes, report, problems };
}

/** "d3 14:05": day of the week (from 1) and time of day. */
function stamp(o: WeekOptions, at: number): string {
  const ms = at - o.startedAt;
  const day = Math.floor(ms / DAY_MS) + 1;
  const t = new Date(o.startedAt + ms).toISOString().slice(11, 16);
  return `d${day} ${t}`;
}

interface OrderTally {
  sent: number;
  ok: number;
  failures: string[];
}

function tally(w: WakeResult): OrderTally {
  const results = (w.results as { results?: { ok: boolean; do?: string; message?: string }[] } | null)?.results ?? [];
  return {
    sent: results.length,
    ok: results.filter((r) => r.ok).length,
    failures: results.filter((r) => !r.ok).map((r) => `${r.do ?? "?"}: ${r.message ?? ""}`),
  };
}

function wakeLine(o: WeekOptions, w: WeekWake): string {
  const t = tally(w);
  const what = w.outcome === "done" ? `${t.ok}/${t.sent} orders ok` : `${w.outcome}${w.error ? ` (${w.error})` : ""}`;
  return `${w.bot.padEnd(8)} ${String(w.slot + 1).padStart(3)} ${stamp(o, Date.parse(w.at))}  brief ${w.briefTokens ?? "-"} tok · ${w.modelCalls} call${w.modelCalls === 1 ? "" : "s"} · ${what}${w.note ? ` · ${w.note}` : ""}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const n = (x: number) => Math.round(x).toLocaleString("en-US");

/** Refusals a bot sent again unchanged (same order kind, same reason) on its next wake. */
function repeats(wakes: WeekWake[]): { refused: number; repeated: number } {
  let refused = 0;
  let repeated = 0;
  for (let k = 0; k < wakes.length; k++) {
    const now = tally(wakes[k]!).failures;
    refused += now.length;
    const before = k > 0 ? new Set(tally(wakes[k - 1]!).failures) : new Set<string>();
    repeated += now.filter((f) => before.has(f)).length;
  }
  return { refused, repeated };
}

/** The report: the numbers that say whether the bots played coherently and socially, and the evidence for them. */
async function weekReport(x: {
  rules: Rules;
  game: Game;
  store: MemoryStore;
  bots: BotSettings[];
  options: WeekOptions;
  wakes: WeekWake[];
  finished: boolean;
  now: number;
}): Promise<{ report: string; problems: string[] }> {
  const { rules, game, bots, options: o, wakes } = x;
  const problems: string[] = [];
  const over = wakes.filter((w) => (w.briefTokens ?? 0) > o.brief_ceiling_tokens);
  for (const w of over) problems.push(`${w.bot}'s wake ${w.slot + 1} brief was ${w.briefTokens} tokens, over the ${o.brief_ceiling_tokens} ceiling.`);

  const rebuilt = replay(game);
  const replays = isDeepStrictEqual(rebuilt.world, game.world) && isDeepStrictEqual(rebuilt.record, game.record);
  if (!replays) problems.push("The game does not rebuild from its start and orders log.");

  const ranking = await view(x.store, { account: bots[0]!.name }, { what: "rankings" }, x.now);
  const domains = ranking.ok && ranking.what === "rankings" ? ranking.domains : [];
  const names = bots.map((b) => b.boot.designation);
  const isBot = (name: string | null) => name !== null && names.includes(name);
  const total = o.days * o.wakes_per_day;

  const lines: string[] = [];
  lines.push(`# Simulated week: ${bots.map((b) => `${b.boot.designation} (${b.model})`).join(", ")}`, "");
  lines.push(
    `${x.finished ? "Finished" : "Stopped early (resumable)"}: ${wakes.length} of ${total * bots.length} wakes over ${o.days} days, seed ${o.seed}, from ${new Date(o.startedAt).toISOString()}.`,
    `Opponents: the legacy systems and ${o.opponents.join(", ")}.`,
    `Replay: ${replays ? "the game rebuilds exactly from its start and orders log" : "DOES NOT rebuild"}.`,
    "",
  );

  for (const bot of bots) {
    const mine = wakes.filter((w) => w.bot === bot.name);
    const tallies = mine.map(tally);
    const sent = tallies.reduce((s, t) => s + t.sent, 0);
    const ok = tallies.reduce((s, t) => s + t.ok, 0);
    const briefs = mine.map((w) => w.briefTokens).filter((t): t is number => t !== null);
    const sum = (k: "promptTokens" | "completionTokens" | "reasoningTokens" | "cachedTokens") => mine.reduce((s, w) => s + w.usage[k], 0);
    const r = repeats(mine);
    lines.push(`## ${bot.boot.designation} (${bot.model}, ${bot.boot.architecture})`, "");
    lines.push(`- Wakes: ${mine.filter((w) => w.outcome === "done").length} done, ${mine.filter((w) => w.outcome === "failed").length} failed, ${mine.filter((w) => w.outcome === "skipped").length} skipped.`);
    lines.push(`- Orders: ${ok} of ${sent} accepted (${sent ? Math.round((ok / sent) * 100) : 0}%).`);
    lines.push(`- Refused orders sent again unchanged on the next wake: ${r.repeated} of ${r.refused}.`);
    const maxBrief = briefs.length ? Math.max(...briefs) : 0;
    const overHere = over.filter((w) => w.bot === bot.name).length;
    lines.push(`- Brief: at most ${maxBrief} tokens (ceiling ${o.brief_ceiling_tokens}), mean ${briefs.length ? Math.round(briefs.reduce((a, b) => a + b, 0) / briefs.length) : 0}.${overHere ? ` OVER on ${overHere} wakes.` : ""}`);
    lines.push(`- Model: ${mine.reduce((s, w) => s + w.modelCalls, 0)} calls; ${n(sum("promptTokens"))} tokens in (${n(sum("cachedTokens"))} cached), ${n(sum("completionTokens"))} out (${n(sum("reasoningTokens"))} reasoning).`);
    lines.push(`- Lookup rounds: ${mine.filter((w) => w.lookups.length > 0).length}.`);
    const failures = new Map<string, number>();
    for (const t of tallies) for (const msg of t.failures) failures.set(msg, (failures.get(msg) ?? 0) + 1);
    if (failures.size) {
      lines.push("", "| Times refused | Order: reason |", "| --- | --- |");
      for (const [msg, times] of [...failures].sort((a, b) => b[1] - a[1])) lines.push(`| ${times} | ${cell(msg)} |`);
    }
    lines.push("");
  }

  // Phase 4's test: the bots trade, and form and revoke a protocol.
  const trades = game.record.filter((e): e is GameEvent & { type: "trade" } => e.type === "trade" && (isBot(e.makerName) || isBot(e.takerName)));
  const signed = game.record.filter((e): e is GameEvent & { type: "protocol_signed" } => e.type === "protocol_signed" && e.designations.some(isBot));
  const revoking = game.record.filter((e): e is GameEvent & { type: "protocol_revoking" } => e.type === "protocol_revoking" && isBot(e.designation));
  const between = (ns: string[]) => names.every((b) => ns.includes(b));
  const yes = (k: number, both: number) => (k > 0 ? `yes (${k}${names.length > 1 ? `; ${both} between the bots` : ""})` : "NO");
  lines.push("## Phase 4: trade, form and revoke a protocol", "");
  lines.push(`- A bot traded: ${yes(trades.length, trades.filter((e) => between([e.makerName, e.takerName])).length)}.`);
  lines.push(`- A bot signed a protocol: ${yes(signed.length, signed.filter((e) => between(e.designations)).length)}.`);
  lines.push(`- A bot revoked a protocol: ${yes(revoking.length, revoking.filter((e) => between([e.designation, ...e.partnerNames])).length)}.`);
  lines.push("");

  lines.push("## Rankings at the end", "", "| Rank | Mind | Architecture | Power | Territory | Status |", "| --- | --- | --- | --- | --- | --- |");
  for (const d of domains) lines.push(`| ${d.rank ?? "-"} | ${isBot(d.designation) ? `**${d.designation}**` : d.designation} | ${d.architecture} | ${n(d.power)} | ${d.territory} | ${d.status} |`);
  lines.push("");

  // The bots' social life, from the Record (the week reads it whole, private channels included).
  const SOCIAL: GameEvent["type"][] = ["trade", "protocol_signed", "protocol_revoking", "protocol_left", "proposal_closed", "offer_expired", "offers_withdrawn"];
  const involves = (e: GameEvent) => names.some((d) => describe(rules, e).includes(d));
  const social = game.record.filter((e) => SOCIAL.includes(e.type) && involves(e));
  lines.push("## Social", "");
  for (const bot of bots) {
    const id = game.owners.findLast((ow) => ow.account === bot.name)?.domain;
    const by = (d: string) => game.log.filter((e) => e.kind === "orders" && e.account === bot.name).flatMap((e) => (e.kind === "orders" ? e.results : [])).filter((r) => r.ok && r.do === d).length;
    const sent = game.record.filter((e) => e.type === "message" && e.from === id).length;
    const got = game.record.filter((e) => e.type === "message" && e.to === id).length;
    lines.push(
      `- ${bot.boot.designation}: ${by("trade_offer")} offers made, ${by("trade_accept")} accepted, ${by("trade_cancel")} cancelled; ${by("protocol_propose")} protocols proposed, ${by("protocol_accept")} accepted, ${by("protocol_decline")} declined, ${by("protocol_revoke")} revoked; ${by("post")} Commons posts; ${sent} messages sent, ${got} received.`,
    );
  }
  lines.push("");
  for (const e of social) lines.push(`- ${stamp(o, e.at)}: ${describe(rules, e)}`);
  if (social.length === 0) lines.push("No trades or protocols involved the bots.");
  lines.push("");
  const talk = game.record.filter((e): e is GameEvent & { type: "message" } => e.type === "message" && isBot(e.fromName) && isBot(e.toName));
  if (talk.length) {
    lines.push("### Between the bots", "");
    for (const e of talk) lines.push(`- ${stamp(o, e.at)} ${e.fromName} → ${e.toName}: ${cell(e.text)}`);
    lines.push("");
  }
  const posts = game.record.filter((e): e is GameEvent & { type: "post" } => e.type === "post" && isBot(e.designation));
  if (posts.length) {
    lines.push("### The bots on the Commons", "");
    for (const e of posts) lines.push(`- ${stamp(o, e.at)} #${e.post} ${e.designation}${e.replyTo !== null ? ` (re #${e.replyTo})` : ""}: ${cell(e.text)}`);
    lines.push("");
  }

  // Conquest and raids, every mind's, for the tuning pass after this phase.
  const battles = game.record.filter((e): e is GameEvent & { type: "battle" } => e.type === "battle");
  const fights = new Map<string, { raids: number; raidsWon: number; conquests: number; conquestsWon: number; sectors: number }>();
  for (const e of battles) {
    const key = `${e.attackerName}\t${e.defenderName}`;
    const f = fights.get(key) ?? { raids: 0, raidsWon: 0, conquests: 0, conquestsWon: 0, sectors: 0 };
    if (e.mode === "raid") {
      f.raids++;
      if (e.attackerWon) f.raidsWon++;
    } else {
      f.conquests++;
      if (e.attackerWon) {
        f.conquestsWon++;
        f.sectors += e.sectors;
      }
    }
    fights.set(key, f);
  }
  lines.push("## Conquest and raids", "");
  if (fights.size === 0) lines.push("No battles.");
  else {
    lines.push("| Attacker | Defender | Raids won/fought | Conquests won/fought | Sectors taken |", "| --- | --- | --- | --- | --- |");
    for (const [key, f] of [...fights].sort((a, b) => b[1].sectors - a[1].sectors || b[1].raids + b[1].conquests - (a[1].raids + a[1].conquests))) {
      const [a, d] = key.split("\t") as [string, string];
      lines.push(`| ${isBot(a) ? `**${a}**` : a} | ${isBot(d) ? `**${d}**` : d} | ${f.raidsWon}/${f.raids} | ${f.conquestsWon}/${f.conquests} | ${f.sectors} |`);
    }
  }
  const LOUD: GameEvent["type"][] = ["deleted", "converged", "collapsed", "singularity"];
  for (const e of game.record.filter((e) => LOUD.includes(e.type))) lines.push(`- ${stamp(o, e.at)}: ${describe(rules, e)}`);
  lines.push("");

  lines.push("## Wakes", "", "| Bot | # | When | Brief tok | Calls | Tokens in/out | Orders ok | Power | Note |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const w of wakes) {
    const t = tally(w);
    const power = (w.results as { status?: { power?: number } } | null)?.status?.power;
    const what = w.outcome === "done" ? `${t.ok}/${t.sent}` : `${w.outcome}: ${w.error ?? ""}`;
    lines.push(
      `| ${w.bot} | ${w.slot + 1} | ${stamp(o, Date.parse(w.at))} | ${w.briefTokens ?? "-"} | ${w.modelCalls} | ${n(w.usage.promptTokens)}/${n(w.usage.completionTokens)} | ${cell(what)} | ${power === undefined ? "-" : n(power)} | ${cell(w.note ?? "")} |`,
    );
  }
  lines.push("");
  return { report: lines.join("\n"), problems };
}
