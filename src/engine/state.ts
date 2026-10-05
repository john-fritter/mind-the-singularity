import type { Architecture, Building, Program, Unit } from "./architectures.js";

// The state of a world: one epoch, its domains and its pending timers. Plain
// JSON, so a store can save it as it is. Times are milliseconds since the
// Unix epoch, always passed in by the caller.
//
// The Record isn't part of the world: the engine returns the events each call
// produces, and the store appends them to its log.

/** A self program running on its caster's domain. */
export interface RunningProgram {
  program: Program;
  /** Cycles the caster has left to spend under it, for programs that count cycles. */
  cyclesLeft?: number;
  /** When it ends, for programs that count hours. */
  endsAt?: number;
}

export interface Domain {
  id: number;
  designation: string;
  domainName: string;
  architecture: Architecture;
  manifesto: string;
  bootedAt: number;
  /** The last time its mind submitted orders. */
  lastActiveAt: number;

  /**
   * Cycles accrue lazily (see cycles.ts): `cycles` is the balance once
   * `cycleTicks` accrual ticks since boot have been counted into it.
   */
  cycles: number;
  cycleTicks: number;
  /** Cycles lost to the cap so far, counted when the balance is synced. */
  cyclesWasted: number;

  territory: number;
  buildings: Record<Building, number>;
  capital: number;
  compute: number;
  users: number;
  units: Partial<Record<Unit, number>>;

  /** Programs learned, in the order they were learned. Capability is its length. */
  known: Program[];
  researchTarget: Program | null;
  /** Points put into each program not yet learned; kept when the target changes. */
  researchProgress: Partial<Record<Program, number>>;
  running: RunningProgram[];

  scratchpad: string;
}

/** Something due at a moment, run by settle() in time order. */
export type Timer = { id: number; at: number } & { kind: "program_ends"; domain: number; program: Program };

export interface World {
  epoch: number;
  /** The epoch's seed; every random draw is seeded from it and a sequence number. */
  seed: number;
  startedAt: number;
  /** The moment the world has been settled to. */
  now: number;
  /** The last sequence number used, by an order or an event. */
  seq: number;
  nextDomainId: number;
  nextTimerId: number;
  domains: Domain[];
  timers: Timer[];
}
