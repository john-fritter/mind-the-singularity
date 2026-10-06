/**
 * Play a local game from the command line.
 *
 * Usage: npm run play -- <command> [args] [options]
 *
 * The game lives in a save file (game.json unless --save says otherwise)
 * with its own clock, which moves only when told to: `advance 6h`, or
 * --at / --advance on any command. So a week can be played in minutes.
 * Every command goes through src/game/, as the MCP server and web view will.
 * Whenever the clock moves, the legacy systems and any scripted players
 * added with `add` take the wakes that fell due, before the command runs.
 */

import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { loadRules } from "../config.js";
import { ARCHITECTURES } from "../engine/architectures.js";
import { loadPlayers } from "../config.js";
import { bootMind, newGame, submitOrders } from "../game/game.js";
import { briefText, span } from "../game/brief.js";
import { getBrief, view } from "../game/read.js";
import { replay } from "../game/replay.js";
import type { GameError } from "../game/state.js";
import { drive, legacySeats, scriptedSeat, type Seat } from "../players/drive.js";
import { STRATEGIES, type StrategyName } from "../players/settings.js";
import { MemoryStore } from "../store/memory.js";
import { readSave, writeSave, type SaveFile, type SavedPlayer } from "../store/save.js";
import { renderMessages, renderOrders, renderPage, renderPosts, renderRankings, renderRecord, when } from "./render.js";

const HELP = `Play Mind: the Singularity locally.

  npm run play -- <command> [args] [options]

Commands
  new                          start a game (--seed N, --at TIME, --force to overwrite)
  boot DESIGNATION "DOMAIN" ARCHITECTURE
                               boot your mind (--manifesto TEXT); architectures:
                               ${ARCHITECTURES.join(", ")}
  brief                        your mind's brief
  orders '[{"do": ...}]'       submit orders: JSON here, from --file, or on stdin
  view NAME                    a domain's public page
  record                       the public Record (--mind NAME, --type TYPE, --limit N, --before SEQ)
  rankings                     every live mind by power
  commons                      the Commons, newest first (--limit N, --before POST)
  thread POST                  a Commons thread in full
  channel [NAME]               your messages, or those with one mind (--limit N, --before SEQ)
  add STRATEGY [DESIGNATION]   add a scripted opponent (--arch ARCHITECTURE); strategies:
                               ${[...STRATEGIES, "random"].join(", ")}
  players                      the scripted players in this game
  advance DURATION             move the game's clock, e.g. 6h, 1d12h, 30m
  replay                       check the save rebuilds from its start and orders log

Options
  --save FILE      the save file (default game.json)
  --as ACCOUNT     who you are (default local); one live mind per account
  --at TIME        move the clock to TIME (ISO 8601) first
  --advance DUR    move the clock forward by DUR first
  --json           print the game layer's raw result`;

const OPTIONS = {
  save: { type: "string", default: "game.json" },
  as: { type: "string", default: "local" },
  at: { type: "string" },
  advance: { type: "string" },
  seed: { type: "string" },
  force: { type: "boolean", default: false },
  manifesto: { type: "string" },
  arch: { type: "string" },
  file: { type: "string", short: "f" },
  mind: { type: "string" },
  type: { type: "string" },
  limit: { type: "string" },
  before: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

class CliError extends Error {}

const UNITS_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** "1d12h30m" → milliseconds. */
export function parseDuration(text: string): number {
  const parts = [...text.matchAll(/(\d+)\s*([dhm])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== text.replace(/\s+/g, "")) {
    throw new CliError(`"${text}" isn't a duration; try 6h, 1d12h or 30m.`);
  }
  return parts.reduce((ms, p) => ms + Number(p[1]) * UNITS_MS[p[2]!]!, 0);
}

function parseTime(text: string): number {
  const t = Date.parse(text);
  if (!Number.isFinite(t)) throw new CliError(`"${text}" isn't a time; try 2026-10-05T12:00Z.`);
  return t;
}

function int(text: string | undefined, what: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^-?\d+$/.test(text)) throw new CliError(`${what} must be a whole number.`);
  return Number(text);
}

function fail(e: GameError): never {
  throw new CliError(e.error);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const { values: o, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...args] = positionals;
  if (o.help || !command || command === "help") {
    console.log(HELP);
    return;
  }
  const out = (raw: unknown, text: string) => console.log(o.json ? JSON.stringify(raw, null, 2) : text);

  if (command === "new") {
    if (existsSync(o.save) && !o.force) throw new CliError(`${o.save} exists; use --force to start over, or --save for another file.`);
    const startedAt = o.at !== undefined ? parseTime(o.at) : Math.floor(Date.now() / 60_000) * 60_000;
    const seed = int(o.seed, "--seed") ?? randomInt(2 ** 31);
    const game = newGame(loadRules(), { epoch: 1, seed, startedAt });
    writeSave(o.save, { version: 1, clock: startedAt, game, players: [] });
    out(game.start, `New game in ${o.save}: epoch 1, seed ${seed}, starting ${when(startedAt, startedAt)}.`);
    return;
  }

  if (!existsSync(o.save)) throw new CliError(`No game at ${o.save}; start one with: npm run play -- new`);
  const save: SaveFile = readSave(o.save);
  const { game } = save;
  warnIfRulesChanged(save);
  const before = save.clock;
  if (o.at !== undefined) save.clock = parseTime(o.at);
  if (o.advance !== undefined) save.clock += parseDuration(o.advance);
  if (command === "advance") {
    if (!args[0]) throw new CliError("Usage: advance DURATION, e.g. advance 6h");
    save.clock += parseDuration(args.join(""));
  }
  if (save.clock < before) throw new CliError("The game's clock never runs backward.");
  const store = new MemoryStore(game);
  const me = { account: o.as };
  const now = save.clock;
  const startedAt = game.start.startedAt;
  let wrote = false;

  // The wakes that fell due while the clock moved, before the command runs.
  const settings = loadPlayers();
  const seatOf = (p: SavedPlayer): Seat => scriptedSeat(settings, p);
  if (now > before) {
    const woke = await drive(store, [...legacySeats(game.rules), ...save.players.map(seatOf)], before, now, settings.steps_per_wake);
    if (woke.length > 0) {
      wrote = true;
      if (!o.json) console.error(`(${woke.length} scripted wake${woke.length === 1 ? "" : "s"} ran while the clock moved.)`);
    }
  }

  switch (command) {
    case "boot": {
      const [designation, domainName, architecture] = args;
      if (!designation || !domainName || !architecture) throw new CliError('Usage: boot DESIGNATION "DOMAIN NAME" ARCHITECTURE');
      const input = { designation, domainName, architecture: architecture.toLowerCase(), ...(o.manifesto !== undefined ? { manifesto: o.manifesto } : {}) };
      const result = await bootMind(store, me, input, now);
      if (!result.ok) fail(result);
      wrote = true;
      out(result, `${result.designation} is online, run by ${o.as}. Its boot period shields it for the first hours; read your brief next.`);
      break;
    }
    case "brief": {
      const brief = await getBrief(store, me, now);
      if ("ok" in brief) fail(brief);
      else out(brief, briefText(game.rules, brief));
      break;
    }
    case "orders": {
      const text = o.file !== undefined ? readFileSync(o.file, "utf-8") : args.length > 0 ? args.join(" ") : await readStdin();
      let orders: unknown;
      try {
        orders = JSON.parse(text);
      } catch (err) {
        throw new CliError(`The orders aren't JSON: ${(err as Error).message}`);
      }
      // A single order is fine on the command line.
      if (!Array.isArray(orders)) orders = [orders];
      const result = await submitOrders(store, me, orders, now);
      if (!result.ok) fail(result);
      wrote = true;
      out(result, renderOrders(result.results, result.status));
      break;
    }
    case "view": {
      if (!args[0]) throw new CliError("Usage: view NAME");
      const result = await view(store, me, { what: "domain", name: args.join(" ") }, now);
      if (!result.ok) fail(result);
      else if (result.what === "domain") out(result, renderPage(game.rules, result.domain, startedAt));
      break;
    }
    case "record": {
      const query = {
        what: "record",
        ...(o.mind !== undefined ? { mind: o.mind } : {}),
        ...(o.type !== undefined ? { type: o.type } : {}),
        ...(o.limit !== undefined ? { limit: int(o.limit, "--limit") } : {}),
        ...(o.before !== undefined ? { before: int(o.before, "--before") } : {}),
      };
      const result = await view(store, me, query, now);
      if (!result.ok) fail(result);
      else if (result.what === "record") out(result, renderRecord(result.entries, result.more, startedAt));
      break;
    }
    case "rankings": {
      const result = await view(store, me, { what: "rankings" }, now);
      if (!result.ok) fail(result);
      else if (result.what === "rankings") out(result, renderRankings(game.rules, result.domains));
      break;
    }
    case "commons":
    case "channel": {
      const query = {
        what: command,
        ...(command === "channel" && args.length > 0 ? { name: args.join(" ") } : {}),
        ...(o.limit !== undefined ? { limit: int(o.limit, "--limit") } : {}),
        ...(o.before !== undefined ? { before: int(o.before, "--before") } : {}),
      };
      const result = await view(store, me, query, now);
      if (!result.ok) fail(result);
      else if (result.what === "commons") out(result, renderPosts(result.posts, result.more, startedAt));
      else if (result.what === "channel") out(result, renderMessages(result.messages, result.more, startedAt));
      break;
    }
    case "thread": {
      if (!args[0]) throw new CliError("Usage: thread POST");
      const result = await view(store, me, { what: "thread", post: int(args[0], "POST") }, now);
      if (!result.ok) fail(result);
      else if (result.what === "thread") out(result, renderPosts(result.posts, false, startedAt));
      break;
    }
    case "add": {
      const strategy = args[0]?.toLowerCase() as StrategyName | undefined;
      if (!strategy || ![...STRATEGIES, "random"].includes(strategy)) {
        throw new CliError(`Usage: add STRATEGY [DESIGNATION]; strategies: ${[...STRATEGIES, "random"].join(", ")}`);
      }
      const seed = randomInt(2 ** 31);
      const designation = args[1] ?? `${strategy.toUpperCase()}-${save.players.length + 1}`;
      const architecture = (o.arch?.toLowerCase() ?? ARCHITECTURES[seed % ARCHITECTURES.length]) as (typeof ARCHITECTURES)[number];
      const player: SavedPlayer = { account: `bot:${designation.toLowerCase()}`, strategy, seed, boot: { designation, domainName: `The ${strategy} domain`, architecture } };
      const booted = await bootMind(store, { account: player.account }, player.boot, now);
      if (!booted.ok) fail(booted);
      save.players.push(player);
      wrote = true;
      out(booted, `${booted.designation} (${strategy}, ${architecture}) is online and plays as the clock moves.`);
      break;
    }
    case "players": {
      const lines = save.players.map((p) => `${p.boot.designation.padEnd(16)} ${p.strategy.padEnd(10)} ${p.boot.architecture}`);
      const legacy = game.rules.legacy.systems.map((l) => `${l.designation.padEnd(16)} ${"legacy".padEnd(10)} ${l.architecture}`);
      out({ players: save.players }, [...legacy, ...lines].join("\n"));
      break;
    }
    case "advance": {
      out({ clock: save.clock }, `The clock moved ${span(save.clock - before)}: it's now ${when(save.clock, startedAt)}.`);
      break;
    }
    case "replay": {
      const rebuilt = replay(game);
      const same = isDeepStrictEqual(rebuilt.world, game.world) && isDeepStrictEqual(rebuilt.record, game.record);
      if (!same) throw new CliError(`${o.save} does NOT rebuild from its log: the world or the Record differs.`);
      out({ ok: true }, `${o.save} rebuilds exactly from its start and ${game.log.length} logged writes.`);
      break;
    }
    default:
      throw new CliError(`Unknown command "${command}". Try: npm run play -- help`);
  }

  if (wrote || save.clock !== before) writeSave(o.save, save);
}

/** An epoch plays by the rules it was created with; say so when config/rules.yaml has moved on. */
function warnIfRulesChanged(save: SaveFile) {
  try {
    if (!isDeepStrictEqual(loadRules(), save.game.rules)) {
      console.error("Note: config/rules.yaml has changed since this game began; the game keeps the rules it started with.");
    }
  } catch {
    console.error("Note: config/rules.yaml doesn't load; the game plays by the rules saved with it.");
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? err.message : err);
  process.exitCode = 1;
});
