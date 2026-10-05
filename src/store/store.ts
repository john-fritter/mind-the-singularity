import type { Game, Write } from "../game/state.js";

// Where a game lives. memory.ts holds it in the process (tests, the
// simulator, the CLI with its save file); Phase 3's postgres.ts keeps it in
// the database. Writes are serialized: `update` runs one at a time, under
// the store's lock, against the latest game.

export interface WorldStore {
  /** The current game. Callers must not change it. */
  read(): Promise<Game>;
  /**
   * Runs `fn` on the current game under the store's lock and applies the
   * write it returns, if any. Returns `fn`'s value.
   */
  update<T>(fn: (game: Game) => { write: Write | null; value: T }): Promise<T>;
}

/** Applies a write to a game in place: the store's half of `update`. */
export function applyWrite(game: Game, write: Write): void {
  game.world = write.world;
  game.log.push(write.entry);
  game.record.push(...write.events);
  if (write.owner) game.owners.push(write.owner);
}
