import { collapse } from "./convergence.js";
import { HOUR_MS } from "./cycles.js";
import { leaveOnDeletion } from "./protocols.js";
import { emit, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";

// Deletion: at 0 cores the mind is gone. The domain stays in the world,
// marked deleted, so the Record and the Archive can still name it; it can't
// act or be targeted, and its timers go with it, as do its open trade
// offers and what they held in escrow. It leaves its protocol at once, and
// its protocol proposals close.

/** Deletes a mind. Mutates the world and the domain. */
export function deleteMind(world: World, d: Domain, now: number, events: GameEvent[], by: Domain | null): void {
  d.deletedAt = now;
  d.running = [];
  d.countermeasure = null;
  d.researchTarget = null;
  d.safeModeUntil = null;
  const offers = new Set(world.offers.filter((o) => o.from === d.id).map((o) => o.id));
  world.offers = world.offers.filter((o) => !offers.has(o.id));
  world.timers = world.timers.filter(
    (t) => !(t.kind === "program_ends" && t.domain === d.id) && !(t.kind === "offer_expires" && offers.has(t.offer)),
  );
  leaveOnDeletion(world, d, now, events);
  emit(world, events, now, {
    type: "deleted",
    domain: d.id,
    designation: d.designation,
    domainName: d.domainName,
    by: by?.id ?? null,
    byName: by?.designation ?? null,
  });
  if (d.convergedAt !== null) collapse(world, now, events, "deleted");
}

/** When a deleted mind's agent may boot a fresh domain. Keys: deletion.reboot_after_hours */
export function rebootAt(rules: Rules, d: Domain): number | null {
  return d.deletedAt === null ? null : d.deletedAt + rules.deletion.reboot_after_hours * HOUR_MS;
}
