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

// The simulated week (phase 3e): one model bot against the legacy systems
// and scripted minds, on a fake clock. The real MCP server is served on a
// loopback port with the week's clock injected, and the bot plays through
// it with the runner's own wake, as `npm run runner -- wake` does; between
// its wakes the scripted players take theirs (players/drive.ts). The week
// isn't a player: like the simulator, it reads the whole world to report.
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
  model: ChatModel;
  sleep(ms: number): Promise<void>;
  /** Progress lines, as wakes finish. */
  log(line: string): void;
}

/** What week.json keeps: the options the run started with, and how far it got. */
interface Progress {
  options: WeekOptions;
  /** Wakes done (the bot's slots), counting from 0. */
  wakesDone: number;
}

/** One line of wakes.jsonl: the runner's result, and what the week measured. */
export interface WeekWake extends WakeResult {
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

/** The bot's wake time in slot k: a seeded whole minute inside the slot. */
export function wakeAt(o: WeekOptions, slot: number): number {
  const every = DAY_MS / o.wakes_per_day;
  const minutes = Math.floor(rngFor(o.seed, 1_000 + slot).next() * (every / MINUTE_MS));
  return o.startedAt + slot * every + minutes * MINUTE_MS;
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
  input: { rules: Rules; players: Players; runner: RunnerSettings; bot: BotSettings; persona: string; options: WeekOptions; dir: string; resume: boolean },
): Promise<WeekOutcome> {
  const { rules, players, runner, bot, persona, dir } = input;
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
  const game: Game = save.game;
  const store = new MemoryStore(game);
  const seats: Seat[] = [...legacySeats(rules), ...save.players.map((p) => scriptedSeat(players, p))];

  // The real MCP server, on a loopback port, on the week's clock. The bot's
  // key lives only in this process.
  const clock = { now: save.clock };
  const key = randomBytes(24).toString("hex");
  const app = createMcpApp({
    epochs: fixedEpoch(store),
    now: () => clock.now,
    identify: async (k) => (k === key ? { account: bot.name } : null),
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const model = new Watched(deps.model);

  const total = o.days * o.wakes_per_day;
  let finished = true;
  // Scripted wakes are run in (from, to]; a fresh week starts just before its first moment.
  let from = progress.wakesDone === 0 && save.clock === o.startedAt ? o.startedAt - 1 : save.clock;
  try {
    for (let slot = progress.wakesDone; slot < total; slot++) {
      if (game.world.ended) break;
      const at = wakeAt(o, slot);
      await drive(store, seats, from, at, players.steps_per_wake);
      clock.now = from = at;
      if (game.world.ended) break;
      const result = await runWake({ connect: httpGame(url), model, now: () => new Date(clock.now), sleep: deps.sleep }, runner, bot, persona, { gameKey: key });
      if (result.outcome === "failed" && model.failed) {
        deps.log(`Stopped at wake ${slot + 1}: the model call failed (${result.error}). Resume with --resume.`);
        finished = false;
        break;
      }
      const message = result.transcript.find((m) => m.role === "user")?.content;
      const brief = typeof message === "string" ? briefInMessage(message) : null;
      const wake: WeekWake = { ...result, slot, briefTokens: brief === null ? null : countTokens(brief) };
      appendFileSync(f.wakes, `${JSON.stringify(wake)}\n`);
      save.clock = clock.now;
      writeSave(f.save, save);
      progress.wakesDone = slot + 1;
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
  const { report, problems } = await weekReport({ rules, game, store, bot, options: o, wakes, finished, now: clock.now });
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
  return `${String(w.slot + 1).padStart(3)} ${stamp(o, Date.parse(w.at))}  brief ${w.briefTokens ?? "-"} tok · ${w.modelCalls} call${w.modelCalls === 1 ? "" : "s"} · ${what}${w.note ? ` · ${w.note}` : ""}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const n = (x: number) => Math.round(x).toLocaleString("en-US");

/** The report: the numbers that say whether the bot played coherently, and the evidence for them. */
async function weekReport(x: {
  rules: Rules;
  game: Game;
  store: MemoryStore;
  bot: BotSettings;
  options: WeekOptions;
  wakes: WeekWake[];
  finished: boolean;
  now: number;
}): Promise<{ report: string; problems: string[] }> {
  const { rules, game, bot, options: o, wakes } = x;
  const problems: string[] = [];
  const done = wakes.filter((w) => w.outcome === "done");
  const tallies = wakes.map(tally);
  const sent = tallies.reduce((s, t) => s + t.sent, 0);
  const ok = tallies.reduce((s, t) => s + t.ok, 0);
  const briefs = wakes.map((w) => w.briefTokens).filter((t): t is number => t !== null);
  const maxBrief = briefs.length ? Math.max(...briefs) : 0;
  const over = wakes.filter((w) => (w.briefTokens ?? 0) > o.brief_ceiling_tokens);
  for (const w of over) problems.push(`Wake ${w.slot + 1}'s brief was ${w.briefTokens} tokens, over the ${o.brief_ceiling_tokens} ceiling.`);
  const sum = (k: "promptTokens" | "completionTokens" | "reasoningTokens" | "cachedTokens") => wakes.reduce((s, w) => s + w.usage[k], 0);
  const calls = wakes.reduce((s, w) => s + w.modelCalls, 0);

  const rebuilt = replay(game);
  const replays = isDeepStrictEqual(rebuilt.world, game.world) && isDeepStrictEqual(rebuilt.record, game.record);
  if (!replays) problems.push("The game does not rebuild from its start and orders log.");

  const ranking = await view(x.store, { account: bot.name }, { what: "rankings" }, x.now);
  const domains = ranking.ok && ranking.what === "rankings" ? ranking.domains : [];
  const designation = bot.boot.designation;

  const failures = new Map<string, number>();
  for (const t of tallies) for (const msg of t.failures) failures.set(msg, (failures.get(msg) ?? 0) + 1);

  // Lantern's fights and fortunes, from the public Record.
  const LOUD: GameEvent["type"][] = ["battle", "hostile", "safe_mode", "deleted", "converged"];
  const mine = game.record.filter((e) => LOUD.includes(e.type)).map((e) => ({ e, text: describe(rules, e) })).filter((x) => x.text.includes(designation));

  const lines: string[] = [];
  lines.push(`# Simulated week: ${designation} (${bot.model})`, "");
  lines.push(
    `${x.finished ? "Finished" : "Stopped early (resumable)"}: ${wakes.length} of ${o.days * o.wakes_per_day} wakes over ${o.days} days, seed ${o.seed}, from ${new Date(o.startedAt).toISOString()}.`,
    `Opponents: the legacy systems and ${o.opponents.join(", ")}.`,
    "",
  );
  lines.push("## Summary", "");
  lines.push(`- Wakes: ${done.length} done, ${wakes.filter((w) => w.outcome === "failed").length} failed, ${wakes.filter((w) => w.outcome === "skipped").length} skipped.`);
  lines.push(`- Orders: ${ok} of ${sent} accepted (${sent ? Math.round((ok / sent) * 100) : 0}%).`);
  lines.push(`- Brief: at most ${maxBrief} tokens (ceiling ${o.brief_ceiling_tokens}), mean ${briefs.length ? Math.round(briefs.reduce((a, b) => a + b, 0) / briefs.length) : 0}.${over.length ? ` OVER on ${over.length} wakes.` : ""}`);
  lines.push(`- Model: ${calls} calls; ${n(sum("promptTokens"))} tokens in (${n(sum("cachedTokens"))} cached), ${n(sum("completionTokens"))} out (${n(sum("reasoningTokens"))} reasoning).`);
  lines.push(`- Lookup rounds: ${wakes.filter((w) => w.lookups.length > 0).length}.`);
  lines.push(`- Replay: ${replays ? "the game rebuilds exactly from its start and orders log" : "DOES NOT rebuild"}.`);
  lines.push("");

  lines.push("## Rankings at the end", "", "| Rank | Mind | Architecture | Power | Territory | Status |", "| --- | --- | --- | --- | --- | --- |");
  for (const d of domains) lines.push(`| ${d.rank ?? "-"} | ${d.designation === designation ? `**${d.designation}**` : d.designation} | ${d.architecture} | ${n(d.power)} | ${d.territory} | ${d.status} |`);
  lines.push("");

  if (failures.size) {
    lines.push("## Refused orders", "", "| Times | Order: reason |", "| --- | --- |");
    for (const [msg, times] of [...failures].sort((a, b) => b[1] - a[1])) lines.push(`| ${times} | ${cell(msg)} |`);
    lines.push("");
  }

  lines.push(`## ${designation} in the Record`, "");
  if (mine.length === 0) lines.push("No battles, hostile programs or deletions involved it.");
  for (const { e, text } of mine) lines.push(`- ${stamp(o, e.at)}: ${text}`);
  lines.push("");

  lines.push("## Wakes", "", "| # | When | Brief tok | Calls | Tokens in/out | Orders ok | Power | Note |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const w of wakes) {
    const t = tally(w);
    const power = (w.results as { status?: { power?: number } } | null)?.status?.power;
    const what = w.outcome === "done" ? `${t.ok}/${t.sent}` : `${w.outcome}: ${w.error ?? ""}`;
    lines.push(
      `| ${w.slot + 1} | ${stamp(o, Date.parse(w.at))} | ${w.briefTokens ?? "-"} | ${w.modelCalls} | ${n(w.usage.promptTokens)}/${n(w.usage.completionTokens)} | ${cell(what)} | ${power === undefined ? "-" : n(power)} | ${cell(w.note ?? "")} |`,
    );
  }
  lines.push("");
  return { report: lines.join("\n"), problems };
}
