import { ARCHITECTURES, type Architecture } from "../engine/architectures.js";
import { DAY_MS } from "../engine/cycles.js";
import { wastedCycles } from "../engine/cycles.js";
import { capability, domainPower } from "../engine/domain.js";
import { rngFor, type Rng } from "../engine/rng.js";
import type { Rules } from "../engine/rules.js";
import type { Domain } from "../engine/state.js";
import { currentMind, newGame } from "../game/game.js";
import type { Game } from "../game/state.js";
import { drive, legacySeats, scriptedSeat, type Seat, type WakeLog } from "../players/drive.js";
import type { Players, StrategyName } from "../players/settings.js";
import { MemoryStore } from "../store/memory.js";

// One simulated epoch: the legacy systems and a draw of scripted minds,
// driven wake by wake to the Shutdown (or the Singularity), and what the
// report needs from it. The simulator isn't a player: it reads the whole
// world to measure it, as the admin view will.

/** The epoch's day marks the report samples, every this many days. */
export const SAMPLE_EVERY_DAYS = 10;

/**
 * Failures the brief can't foresee: a crash, a firewall block, a target's
 * hostile cap (other minds' programs aren't in the brief), and a protocol
 * proposal refused for the other mind's protocol (the brief shows only
 * your own: whether they're in one, it's full, or one of them is leaving).
 */
export const UNFORESEEABLE = [
  / crashed: /,
  /firewalls blocked/,
  /has taken all the hostile programs it can today/,
  /are each in a protocol; a mind is in one at most/,
  /^That protocol would have \d+ minds/,
  /is leaving its protocol; nothing joins it until that lands/,
];

export interface EpochInput {
  rules: Rules;
  settings: Players;
  /** The epoch's seed: the world's, and the draw of minds. */
  seed: number;
  /** Strategies to draw minds from. */
  strategies: StrategyName[];
  minds: number;
  days: number;
}

/** A sample of one mind's domain at a day mark. */
export interface Sample {
  day: number;
  capital: number;
  compute: number;
  territory: number;
  power: number;
  capability: number;
}

/** One scripted mind's epoch. */
export interface SeatResult {
  strategy: StrategyName;
  designation: string;
  architecture: Architecture;
  /** Final power of its current mind (0 if deleted at the end). */
  power: number;
  /** Place among the scripted minds by final power, from 1. */
  rank: number;
  /** Days (fractional, from the epoch's start) at which its minds were deleted. */
  deletions: number[];
  cyclesWasted: number;
  capital: number;
  samples: Sample[];
  /** Times it converged. */
  converged: number;
}

export interface EpochResult {
  seed: number;
  seats: SeatResult[];
  /** Day the epoch ended by the Singularity, or null. */
  singularity: number | null;
  convergences: number;
  collapses: Record<"timeout" | "defeated" | "deleted", number>;
  /** Minds deleted, legacy systems included. */
  deletions: { day: number; legacy: boolean; strategy: StrategyName | "legacy" }[];
  /** Failed orders the brief could have foreseen, with the first few. */
  foreseeable: { count: number; examples: string[] };
  social: Social;
}

/** The social layer in one epoch (phase 4d): counts from the Record, goods traded both ways. */
export interface Social {
  trades: number;
  capitalTraded: number;
  computeTraded: number;
  protocolsSigned: number;
  revocations: number;
  posts: number;
  messages: number;
}

/**
 * The scripted minds for an epoch: each listed strategy once while there's
 * room, and the seats left over dealt in turn from epoch to epoch (by the
 * seed), so over a run every strategy holds about as many seats; then
 * shuffled, with random architectures.
 */
export function drawMinds(rng: Rng, seed: number, strategies: StrategyName[], minds: number): { strategy: StrategyName; architecture: Architecture }[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng.next() * xs.length)]!;
  const n = strategies.length;
  const drawn = strategies.slice(0, minds);
  const extra = minds - drawn.length;
  for (let j = 0; j < extra; j++) drawn.push(strategies[(((seed * extra + j) % n) + n) % n]!);
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [drawn[i], drawn[j]] = [drawn[j]!, drawn[i]!];
  }
  return drawn.map((strategy) => ({ strategy, architecture: pick(ARCHITECTURES) }));
}

function sample(rules: Rules, d: Domain, day: number): Sample {
  return { day, capital: d.capital, compute: d.compute, territory: d.territory, power: domainPower(rules, d), capability: capability(d) };
}

/** Failed orders in these wakes that the brief could have shown would fail. */
export function foreseeableFailures(logs: WakeLog[]): string[] {
  const out: string[] = [];
  for (const log of logs) {
    if (log.error) out.push(`${log.account}: ${log.error}`);
    for (const step of log.steps) {
      for (const r of step.results) {
        if (!r.ok && !UNFORESEEABLE.some((re) => re.test(r.message))) out.push(`${log.kind} ${log.account} ${r.do}: ${r.message}`);
      }
    }
  }
  return out;
}

/** Runs one epoch. */
export async function runEpoch(input: EpochInput): Promise<EpochResult> {
  const { rules, settings, seed } = input;
  const startedAt = Date.UTC(2026, 0, 1);
  const game: Game = newGame(rules, { epoch: 1, seed, startedAt });
  const store = new MemoryStore(game);
  const drawn = drawMinds(rngFor(seed, -1), seed, input.strategies, input.minds);
  const minds = drawn.map((m, i) => {
    const designation = `${m.strategy.toUpperCase()}-${i + 1}`;
    const seat = scriptedSeat(settings, {
      account: `sim:${i + 1}`,
      strategy: m.strategy,
      seed: seed * 100 + i + 1,
      boot: { designation, domainName: "Testbed", architecture: m.architecture },
    });
    return { ...m, designation, seat };
  });
  const seats: Seat[] = [...legacySeats(rules), ...minds.map((m) => m.seat)];
  const strategyOf = new Map(minds.map((m) => [m.seat.account, m.strategy]));

  const days = Math.min(input.days, rules.epoch.length_days);
  const samples = new Map<string, Sample[]>(minds.map((m) => [m.seat.account, []]));
  const foreseeable: string[] = [];
  let from = startedAt - 1;
  // A day at a time, so the wake logs (with their briefs) don't pile up.
  for (let day = 1; day <= days && !game.world.ended; day++) {
    const to = startedAt + day * DAY_MS;
    foreseeable.push(...foreseeableFailures(await drive(store, seats, from, to, settings.steps_per_wake)));
    from = to;
    if (day % SAMPLE_EVERY_DAYS === 0 || day === days) {
      for (const m of minds) {
        const d = currentMind(game, m.seat.account);
        if (d) samples.get(m.seat.account)!.push(sample(rules, d, day));
      }
    }
  }

  const end = game.world.ended?.at ?? startedAt + days * DAY_MS;
  const dayOf = (at: number) => (at - startedAt) / DAY_MS;
  const accountOf = (domain: number) => game.owners.find((o) => o.domain === domain)?.account ?? "";
  const events = game.record;
  const singularity = events.find((e) => e.type === "singularity");
  const collapses = { timeout: 0, defeated: 0, deleted: 0 };
  for (const e of events) if (e.type === "collapsed") collapses[e.reason]++;

  const final = minds.map((m) => {
    const owned = game.owners.filter((o) => o.account === m.seat.account).map((o) => game.world.domains.find((d) => d.id === o.domain)!);
    const current = owned.at(-1);
    const live = current && current.deletedAt === null ? current : undefined;
    return {
      m,
      owned,
      power: live ? domainPower(rules, live) : 0,
      capital: live?.capital ?? 0,
      cyclesWasted: owned.reduce((n, d) => n + (d.deletedAt === null ? wastedCycles(rules, d, end) : d.cyclesWasted), 0),
    };
  });
  const byPower = [...final].sort((a, b) => b.power - a.power);

  return {
    seed,
    seats: final.map((f) => ({
      strategy: f.m.strategy,
      designation: f.m.designation,
      architecture: f.m.architecture,
      power: f.power,
      rank: byPower.indexOf(f) + 1,
      deletions: f.owned.filter((d) => d.deletedAt !== null).map((d) => dayOf(d.deletedAt!)),
      cyclesWasted: f.cyclesWasted,
      capital: f.capital,
      samples: samples.get(f.m.seat.account)!,
      converged: events.filter((e) => e.type === "converged" && f.owned.some((d) => d.id === e.domain)).length,
    })),
    singularity: singularity ? dayOf(singularity.at) : null,
    convergences: events.filter((e) => e.type === "converged").length,
    collapses,
    deletions: events.flatMap((e) => {
      if (e.type !== "deleted") return [];
      const legacy = game.world.domains.find((d) => d.id === e.domain)!.legacy;
      return [{ day: dayOf(e.at), legacy, strategy: legacy ? ("legacy" as const) : strategyOf.get(accountOf(e.domain))! }];
    }),
    foreseeable: { count: foreseeable.length, examples: foreseeable.slice(0, 5) },
    social: socialOf(events),
  };
}

/** What the Record says the minds did socially. */
export function socialOf(events: Game["record"]): Social {
  const out: Social = { trades: 0, capitalTraded: 0, computeTraded: 0, protocolsSigned: 0, revocations: 0, posts: 0, messages: 0 };
  for (const e of events) {
    if (e.type === "trade") {
      out.trades++;
      for (const l of [e.give, e.want]) {
        if (l.goods === "capital") out.capitalTraded += l.amount;
        else out.computeTraded += l.amount;
      }
    } else if (e.type === "protocol_signed") out.protocolsSigned++;
    else if (e.type === "protocol_revoking") out.revocations++;
    else if (e.type === "post") out.posts++;
    else if (e.type === "message") out.messages++;
  }
  return out;
}
