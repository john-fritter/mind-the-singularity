import type { OrderResult } from "../engine/context.js";
import type { GameEvent } from "../engine/record.js";
import type { Rules } from "../engine/rules.js";
import type { World } from "../engine/state.js";

// A game: one epoch's world, and what the game layer keeps around it. The
// engine's world knows nothing about accounts; who owns which mind, the
// orders log and the Record live here. Plain JSON, so a store can save it
// as it is.

/** Who is calling. Phase 3 fills it from the API key or the login. */
export interface Identity {
  account: string;
  /**
   * The account's admin flag (mind.accounts.admin), from a web login only;
   * an API key never carries it. Only src/game/admin.ts reads it: it opens
   * the admin view and changes nothing about how the account plays.
   */
  admin?: boolean;
}

/** An account's mind. An account has at most one live mind; the newest entry is its current one. */
export interface Owner {
  account: string;
  domain: number;
}

/** One write, as it came in, so the game can be rebuilt from its start. */
export type LogEntry = {
  at: number;
  account: string;
  /** The world's sequence number after the write: where its events end. */
  seq: number;
} & (
  | { kind: "boot"; input: unknown; domain: number }
  | { kind: "orders"; domain: number; orders: unknown[]; results: OrderResult[] }
);

export interface Game {
  /** The rules the epoch was created with. An epoch keeps them to its end. */
  rules: Rules;
  /** What createWorld was given. With the log, it rebuilds the world. */
  start: { epoch: number; seed: number; startedAt: number };
  world: World;
  owners: Owner[];
  log: LogEntry[];
  /** Every event, public and private, in sequence order. */
  record: GameEvent[];
}

/** What a write adds to a game. A store applies it under its lock. */
export interface Write {
  world: World;
  entry: LogEntry;
  events: GameEvent[];
  owner?: Owner;
}

/** A refused call. `not_found` covers what doesn't exist and what the caller may not see alike. */
export interface GameError {
  ok: false;
  code: "not_found" | "invalid" | "refused";
  error: string;
}

export const gameError = (code: GameError["code"], error: string): GameError => ({ ok: false, code, error });
