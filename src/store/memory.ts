import type { Game, Write } from "../game/state.js";
import { applyWrite, type WorldStore } from "./store.js";

/**
 * A game held in memory. Writes run one at a time through a promise queue,
 * as Postgres serializes them with a lock. Saving it to a file is the
 * caller's job (save.ts).
 */
export class MemoryStore implements WorldStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly game: Game) {}

  read(): Promise<Game> {
    return Promise.resolve(this.game);
  }

  update<T>(fn: (game: Game) => { write: Write | null; value: T }): Promise<T> {
    const run = this.queue.then(() => {
      const { write, value } = fn(this.game);
      if (write) applyWrite(this.game, write);
      return value;
    });
    // A failed write doesn't block the ones queued after it.
    this.queue = run.catch(() => undefined);
    return run;
  }
}
