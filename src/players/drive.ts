import type { Architecture } from "../engine/architectures.js";
import type { OrderResult } from "../engine/context.js";
import { HOUR_MS } from "../engine/cycles.js";
import { rngFor } from "../engine/rng.js";
import type { Rules } from "../engine/rules.js";
import { bootMind, submitOrders } from "../game/game.js";
import { getBrief, type Brief } from "../game/read.js";
import type { GameError } from "../game/state.js";
import type { WorldStore } from "../store/store.js";
import { legacyPlayers } from "./legacy.js";
import type { Player } from "./player.js";
import type { Players, StrategyName } from "./settings.js";
import { fill, playerFor } from "./strategies.js";

// Runs scripted players on the clock: every wake due between two moments,
// in time order, each one a brief, a decision and a submitOrders, as an
// agent's wake is. The simulator (phase 2e) and the CLI drive games with
// it; in Phase 3 the server's interval timer drives the legacy systems.

/** A seat at the game: an account and the player that plays it, on a schedule. */
export interface Seat {
  account: string;
  player: Player;
  /** What to boot the mind with, for players that boot (and reboot) their own; legacy systems are booted with the game. */
  boot?: { designation: string; domainName: string; architecture: Architecture; manifesto?: string };
  /** The flavor order's fields, sent as one order right after each boot. */
  flavor?: Record<string, string>;
  wakeEveryMs: number;
  /** The first wake comes this long after the epoch starts. */
  offsetMs: number;
  /** Seeds the player's own rolls. */
  seed: number;
}

/** One step of a wake: the orders sent and what came back. */
export interface Step {
  orders: unknown[];
  results: OrderResult[];
}

/** One wake, for reports and tests. */
export interface WakeLog {
  at: number;
  account: string;
  kind: string;
  /** Set when the wake booted the mind. */
  booted?: boolean;
  steps: Step[];
  /** The brief each step was decided from. */
  briefs: Brief[];
  /** A refused boot or submit. */
  error?: string;
}

const isError = (x: unknown): x is GameError => typeof x === "object" && x !== null && (x as GameError).ok === false;

/** Every wake due in (from, to], in time order; seats in their order at the same moment. */
export function wakesBetween(seats: Seat[], startedAt: number, from: number, to: number): { at: number; seat: Seat }[] {
  const out: { at: number; seat: Seat; i: number }[] = [];
  seats.forEach((seat, i) => {
    const first = startedAt + seat.offsetMs;
    let n = Math.max(0, Math.floor((from - first) / seat.wakeEveryMs));
    for (let at = first + n * seat.wakeEveryMs; at <= to; at = first + ++n * seat.wakeEveryMs) {
      if (at > from) out.push({ at, seat, i });
    }
  });
  return out.sort((a, b) => a.at - b.at || a.i - b.i);
}

/** Runs one seat's wake at a moment. */
export async function wake(store: WorldStore, seat: Seat, at: number, stepsPerWake: number): Promise<WakeLog> {
  const me = { account: seat.account };
  const log: WakeLog = { at, account: seat.account, kind: seat.player.kind, steps: [], briefs: [] };
  const { rules } = await store.read();
  let brief = await getBrief(store, me, at);
  const reboot = !isError(brief) && brief.you.deletedAt !== null && brief.you.rebootAt !== null && at >= brief.you.rebootAt;
  if (seat.boot && ((isError(brief) && brief.code === "not_found") || reboot)) {
    const booted = await bootMind(store, me, seat.boot, at);
    if (isError(booted)) return { ...log, error: booted.error };
    log.booted = true;
    if (seat.flavor) {
      const orders = [{ do: "flavor", ...seat.flavor }];
      const out = await submitOrders(store, me, orders, at);
      if (isError(out)) return { ...log, error: out.error };
      log.steps.push({ orders, results: out.results });
    }
    brief = await getBrief(store, me, at);
  }
  if (isError(brief)) return { ...log, error: brief.error };

  let previous: OrderResult[] | null = null;
  for (let step = 1; step <= stepsPerWake; step++) {
    const rng = rngFor(seat.seed, Math.floor(at / 60_000) * 4 + step);
    const orders = seat.player.decide({ brief, rules, step, previous, rng });
    if (orders.length === 0) break;
    log.briefs.push(brief);
    const out = await submitOrders(store, me, orders, at);
    if (isError(out)) return { ...log, error: out.error };
    log.steps.push({ orders, results: out.results });
    previous = out.results;
    const next = await getBrief(store, me, at);
    if (isError(next)) break;
    brief = next;
  }
  return log;
}

/** Runs every wake due in (from, to]. Returns them in the order they ran. */
export async function drive(store: WorldStore, seats: Seat[], from: number, to: number, stepsPerWake: number): Promise<WakeLog[]> {
  const game = await store.read();
  const logs: WakeLog[] = [];
  for (const { at, seat } of wakesBetween(seats, game.start.startedAt, from, to)) {
    if ((await store.read()).world.ended) break;
    logs.push(await wake(store, seat, at, stepsPerWake));
  }
  return logs;
}

/** The legacy systems' seats: each wakes every legacy.wake_every_hours from the epoch's start. */
export function legacySeats(rules: Rules): Seat[] {
  const every = rules.legacy.wake_every_hours * HOUR_MS;
  return legacyPlayers(rules).map((player, i) => ({ account: player.account, player, wakeEveryMs: every, offsetMs: every, seed: i + 1 }));
}

/** A scripted player's seat: the strategy's player, waking every players.wake_every_hours at an offset drawn from its seed. */
export function scriptedSeat(
  settings: Players,
  input: { account: string; strategy: StrategyName; seed: number; boot: NonNullable<Seat["boot"]> },
): Seat {
  const every = settings.wake_every_hours * HOUR_MS;
  // A whole minute inside the first interval, so wakes don't all land together.
  const offsetMs = Math.floor(rngFor(input.seed, 0).next() * (every / 60_000)) * 60_000;
  const flavor = Object.fromEntries(Object.entries(settings.texts.flavor[input.strategy]).map(([k, v]) => [k, fill(v!, { me: input.boot.designation })]));
  return { account: input.account, player: playerFor(input.strategy, settings), boot: input.boot, flavor, wakeEveryMs: every, offsetMs, seed: input.seed };
}
