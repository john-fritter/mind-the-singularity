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
  /** A legacy system: a code-run domain from rules.legacy, booted with the epoch. It doesn't count toward the quorum. */
  legacy: boolean;
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
  /** Commons posts and channel messages sent on epoch day `day` (from 0), for the daily caps. */
  social: { day: number; posts: number; messages: number };

  /** The battle program run automatically when attacked by a force above `above` × this domain's defense. */
  countermeasure: { program: Program; above: number } | null;
  /** When this domain's own attacks were made, within the last day; each makes the next cost more. */
  attacksMade: number[];
  /** When the domain's last won-against attacks landed, within protection.safe_mode_window_hours. */
  hits: number[];
  /** Shielded from attacks and hostile programs until then. */
  safeModeUntil: number | null;
  /** When hostile programs reached the domain, blocked or not, within the last day. */
  hostileReceived: number[];
  /** Who last attacked or ran a hostile program on this domain, and when, within protection.retaliation_hours. */
  aggressors: { domain: number; at: number }[];
  /** Blight stops user growth until then. */
  growthStalledUntil: number | null;
  /** When the mind converged, while its convergence lasts. */
  convergedAt: number | null;
  /** When the mind was deleted (0 cores). A deleted domain stays in the world so the Record can name it. */
  deletedAt: number | null;
  /** Written when the mind is deleted; Phase 5 adds the order that sets it. */
  lastLog: string;
}

/** Something due at a moment, run by settle() in time order. */
export type Timer = { id: number; at: number } & (
  | { kind: "program_ends"; domain: number; program: Program }
  | { kind: "convergence_collapses" }
  | { kind: "shutdown_warning" }
  | { kind: "shutdown" }
);

/** Minds converging into the Singularity, one at a time. */
export interface Convergence {
  /** Domain ids, in the order they converged. */
  minds: number[];
  lastJoinAt: number;
}

/** How the epoch ended. */
export interface Ending {
  at: number;
  outcome: "singularity" | "shutdown";
  /** The converged minds, for a Singularity. */
  ascended: number[];
}

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
  /** Commons posts: entry i is the id of post i + 1's thread, its first post. The posts themselves are in the Record. */
  postRoots: number[];
  convergence: Convergence | null;
  /** Set once the epoch is over; nothing happens after. */
  ended: Ending | null;
}
