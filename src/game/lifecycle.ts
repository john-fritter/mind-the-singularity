import { nextEpochAt } from "../engine/convergence.js";
import type { Rules } from "../engine/rules.js";
import type { Epochs } from "./epochs.js";
import { newGame } from "./game.js";
import { epochOf, settledAt } from "./read.js";

// The epoch lifecycle (DESIGN.md's "The reboot"): an epoch ends with the
// Singularity or the Shutdown; after epoch.downtime_hours the next one
// boots with fresh domains, its legacy systems and the scripted players
// seated in the last. Accounts and API keys carry over; every mind boots
// again. The ended epoch is left as it is, and the Archive reads it from
// there (public.ts).

/**
 * Boots the next epoch if the current one has ended and its downtime has
 * passed. `rules` are the new epoch's (config/rules.yaml as it is now) and
 * `seed` its seed; the caller draws it. Returns the new epoch's number, or
 * null when nothing was due or another process booted it first. Rebooting
 * twice at the same moment boots one epoch.
 */
export async function rebootIfDue(epochs: Epochs, rules: Rules, seed: number, now: number): Promise<number | null> {
  const store = await epochs.current();
  if (!store) return null;
  const game = await store.read();
  // Cheap first: an epoch ends with a convergence (an order, so saved) or at the Shutdown.
  if (!game.world.ended && now < epochOf(game.rules, game.world, now).shutdownAt) return null;
  const { world } = settledAt(game, now);
  if (!world.ended || now < nextEpochAt(game.rules, world.ended)) return null;
  const next = newGame(rules, { epoch: game.start.epoch + 1, seed, startedAt: now });
  return (await epochs.boot(next)) ? next.start.epoch : null;
}
