import type { GameEvent } from "../engine/record.js";
import type { World } from "../engine/state.js";
import { applyOrders, bootMind, createWorld, settle, type BootInput } from "../engine/world.js";
import type { Game } from "./state.js";

// The audit: a game's start and its log rebuild its world and Record
// exactly. Settles aren't logged, since timers are deterministic: each
// write settles first, and a last settle brings the world to the moment
// it was saved at.

/** Rebuilds a game's world and Record from its start and log. Throws if an entry no longer applies. */
export function replay(game: Game): { world: World; record: GameEvent[] } {
  const { rules } = game;
  let world = createWorld(rules, game.start);
  const record: GameEvent[] = [];
  for (const [i, entry] of game.log.entries()) {
    if (entry.kind === "boot") {
      const booted = bootMind(rules, world, entry.input as BootInput, entry.at);
      if (!booted.ok) throw new Error(`log entry ${i}: the boot failed on replay: ${booted.error}`);
      if (booted.domain !== entry.domain) throw new Error(`log entry ${i}: booted domain ${booted.domain}, logged ${entry.domain}`);
      world = booted.world;
      record.push(...booted.events);
    } else {
      const out = applyOrders(rules, world, entry.domain, entry.orders, entry.at);
      world = out.world;
      record.push(...out.events);
    }
  }
  const last = settle(rules, world, game.world.now);
  record.push(...last.events);
  return { world: last.world, record };
}
