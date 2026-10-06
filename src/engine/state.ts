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
  /** Flavor (DESIGN.md "Flavor text and the Record"): no mechanical effect; "" when unset. Keys: flavor.* */
  manifesto: string;
  /** How the mind presents itself to visitors. */
  interface: string;
  /** Its stated purpose, shown under the designation. */
  directive: string;
  /** Its force: the name is woven into battle entries in the Record. */
  force: { name: string; description: string };
  /** Its calling card, left on the loser of every conquest it wins. */
  tag: string;
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
  /** Commons posts, channel messages, trade offers and protocol proposals made on epoch day `day` (from 0), for the daily caps. */
  social: { day: number; posts: number; messages: number; offers: number; proposals: number };

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
  /** Written once, after the mind is deleted, with the last_log order; kept in the Archive. */
  lastLog: string;
}

/** What a trade moves: capital or compute. */
export type Goods = "capital" | "compute";

export interface Lot {
  goods: Goods;
  amount: number;
}

/** An open trade offer. Its `give` is in escrow: out of the maker's domain until it's accepted, cancelled or expires. */
export interface Offer {
  id: number;
  from: number;
  /** The only mind that may accept it, or null for anyone. */
  to: number | null;
  give: Lot;
  want: Lot;
  madeAt: number;
  expiresAt: number;
}

/** A non-aggression protocol: its members can't attack each other or run hostile programs on each other. */
export interface Protocol {
  id: number;
  /** Domain ids, in the order they joined. */
  members: number[];
  /** Members who revoked, and when each leaves. Until then the protocol still holds them. */
  leaving: { domain: number; at: number }[];
}

/** A proposed protocol, or a mind joining one, waiting on every yes but its proposer's. */
export interface Proposal {
  id: number;
  from: number;
  /** The mind it was proposed to. */
  to: number;
  /** The protocol it would make, proposer first. */
  members: number[];
  /** The protocol `members` would grow, if one of the two was in one. */
  protocol: number | null;
  /** Members who haven't said yes yet. */
  awaiting: number[];
  madeAt: number;
  expiresAt: number;
}

/** Something due at a moment, run by settle() in time order. */
export type Timer = { id: number; at: number } & (
  | { kind: "program_ends"; domain: number; program: Program }
  | { kind: "offer_expires"; offer: number }
  | { kind: "proposal_expires"; proposal: number }
  | { kind: "protocol_revoked"; protocol: number; domain: number }
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
  /** Open trade offers, oldest first. Closed ones are gone; done trades are in the Record. */
  offers: Offer[];
  /** The last offer number used; they count from 1 for the epoch. */
  lastOfferId: number;
  /** Protocols in force, oldest first. A mind is in one at most. */
  protocols: Protocol[];
  lastProtocolId: number;
  /** Open protocol proposals, oldest first; a mind has one open at most. */
  proposals: Proposal[];
  /** The last proposal number used; they count from 1 for the epoch. */
  lastProposalId: number;
  convergence: Convergence | null;
  /** Set once the epoch is over; nothing happens after. */
  ended: Ending | null;
}
