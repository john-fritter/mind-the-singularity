import type { Pool } from "pg";
import { MemoryStore } from "../store/memory.js";
import { createNextEpoch, epochNumbers, latestEpoch, openEpoch, type PostgresStore } from "../store/postgres.js";
import type { WorldStore } from "../store/store.js";
import type { Game } from "./state.js";

// Which games a front end reads: the current epoch, and the past ones for
// the Archive. Front ends that may not touch the store (the MCP server, the
// web view) get them from here and hand them back to src/game/'s functions
// without looking inside.

export interface Epochs {
  /** The current epoch's game, or null when there's none yet. */
  current(): Promise<WorldStore | null>;
  /** Every epoch's number, newest first. */
  numbers(): Promise<number[]>;
  /** An epoch's game by its number, or null when there's no such epoch. */
  epoch(number: number): Promise<WorldStore | null>;
  /**
   * The reboot: stores `game` as the next epoch, with the scripted players
   * seated in the one before. False when that epoch exists already, so two
   * processes rebooting at once boot it once. Only lifecycle.ts calls it.
   */
  boot(game: Game): Promise<boolean>;
}

/**
 * The epochs in the database; the newest is the current one. Each epoch's
 * store is kept for the process, so its cache lasts across calls.
 */
export function databaseEpochs(pool: Pool): Epochs {
  // Kept by the row's id, not its number: a discarded test epoch's number
  // comes back for the next one (npm run epoch -- discard).
  const kept = new Map<number, PostgresStore>();
  const epoch = async (number: number) => {
    const opened = await openEpoch(pool, number);
    if (!opened) return null;
    const store = kept.get(opened.epochId) ?? opened;
    kept.set(opened.epochId, store);
    return store;
  };
  return {
    async current() {
      const number = await latestEpoch(pool);
      return number === null ? null : epoch(number);
    },
    numbers: () => epochNumbers(pool),
    epoch,
    boot: async (game) => (await createNextEpoch(pool, game)) !== null,
  };
}

/** One game, always: tests and the simulated week. */
export function fixedEpoch(store: WorldStore): Epochs {
  return listedEpochs([store]);
}

/** Games held in memory, the last of them the current one: tests. */
export function listedEpochs(stores: WorldStore[]): Epochs {
  const numbered = async () => Promise.all(stores.map(async (store) => ({ number: (await store.read()).start.epoch, store })));
  return {
    current: async () => stores.at(-1) ?? null,
    numbers: async () => (await numbered()).map((e) => e.number).reverse(),
    epoch: async (number) => (await numbered()).find((e) => e.number === number)?.store ?? null,
    async boot(game) {
      if ((await numbered()).some((e) => e.number === game.start.epoch)) return false;
      stores.push(new MemoryStore(structuredClone(game)));
      return true;
    },
  };
}
