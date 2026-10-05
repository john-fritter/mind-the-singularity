import type { Pool } from "pg";
import { latestEpoch, openEpoch, type PostgresStore } from "../store/postgres.js";
import type { WorldStore } from "../store/store.js";

// Which game a front end plays: the current epoch. Front ends that may not
// touch the store (the MCP server, the web view) get it from here and hand
// it back to src/game/'s functions without looking inside.

export interface Epochs {
  /** The current epoch's game, or null when there's none yet. */
  current(): Promise<WorldStore | null>;
}

/**
 * The newest epoch in the database. Its store is kept for the process, so
 * the store's cache lasts across calls; a newer epoch replaces it.
 */
export function databaseEpochs(pool: Pool): Epochs {
  let kept: { number: number; store: PostgresStore } | null = null;
  return {
    async current() {
      const number = await latestEpoch(pool);
      if (number === null) return null;
      if (kept?.number !== number) {
        const store = await openEpoch(pool, number);
        if (!store) return null;
        kept = { number, store };
      }
      return kept.store;
    },
  };
}

/** One game, always: tests and the simulated week. */
export function fixedEpoch(store: WorldStore): Epochs {
  return { current: async () => store };
}
