import { collapse, endEpoch } from "./convergence.js";
import { emit, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import type { Timer, World } from "./state.js";
import { expireProposal, revocationLands } from "./protocols.js";
import { expireOffer } from "./trades.js";

// No tick: what happens on the clock is a due timer, run here in time order
// (ties in the order they were set) before any read or write. Settling twice
// to the same moment changes nothing, since a timer runs once and is gone.

/** Runs one timer. Mutates the world. */
function fire(rules: Rules, world: World, timer: Timer, events: GameEvent[]): void {
  switch (timer.kind) {
    case "program_ends": {
      const domain = world.domains.find((d) => d.id === timer.domain);
      if (!domain) return;
      // A program run again before it ended has a later end and its own timer.
      const ended = domain.running.filter((r) => r.program === timer.program && r.endsAt !== undefined && r.endsAt <= timer.at);
      if (ended.length === 0) return;
      domain.running = domain.running.filter((r) => !ended.includes(r));
      emit(world, events, timer.at, { type: "program_ended", domain: domain.id, program: timer.program });
      return;
    }
    case "offer_expires":
      expireOffer(rules, world, timer.offer, timer.at, events);
      return;
    case "proposal_expires":
      expireProposal(world, timer.proposal, timer.at, events);
      return;
    case "protocol_revoked":
      revocationLands(world, timer.protocol, timer.domain, timer.at, events);
      return;
    case "convergence_collapses":
      collapse(world, timer.at, events, "timeout");
      return;
    case "shutdown_warning":
      emit(world, events, timer.at, { type: "shutdown_warning", day: rules.epoch.length_days });
      return;
    case "shutdown":
      emit(world, events, timer.at, { type: "shutdown" });
      endEpoch(world, { at: timer.at, outcome: "shutdown", ascended: [] });
      return;
  }
}

const earlier = (a: Timer, b: Timer) => a.at - b.at || a.id - b.id;

/** Runs every timer due by `now` and moves the world to `now`. Mutates the world. */
export function settleInPlace(rules: Rules, world: World, now: number, events: GameEvent[]): void {
  if (now < world.now) throw new Error(`can't settle to ${now}: the world is already at ${world.now}`);
  for (;;) {
    const due = world.timers.filter((t) => t.at <= now).sort(earlier)[0];
    if (!due) break;
    world.timers = world.timers.filter((t) => t !== due);
    fire(rules, world, due, events);
  }
  world.now = now;
}
