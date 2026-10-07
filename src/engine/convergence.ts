import { DAY_MS, HOUR_MS } from "./cycles.js";
import { emit, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import type { Domain, Ending, World } from "./state.js";

// The Singularity and the Shutdown (DESIGN.md, Epochs and the Singularity).
// Minds converge one at a time, at least join_gap_hours apart; the quorum is
// measured at each join; 72 hours without the next mind, a converged mind
// losing a conquest as defender, or one being deleted collapses the
// convergence. Day 60 ends the epoch regardless.

/**
 * Minds needed for the Singularity, given how many domains are active.
 * Keys: convergence.quorum_divisor, convergence.quorum_min, convergence.quorum_max
 */
export function quorum(rules: Rules, activeDomains: number): number {
  const c = rules.convergence;
  return Math.min(c.quorum_max, Math.max(c.quorum_min, Math.ceil(activeDomains / c.quorum_divisor)));
}

/**
 * Whether a domain counts toward the quorum: a mind, not a legacy system,
 * not deleted, and active in the window or converged.
 * Keys: convergence.active_window_hours
 */
export function isActive(rules: Rules, d: Domain, now: number): boolean {
  if (d.deletedAt !== null || d.legacy) return false;
  return d.convergedAt !== null || d.lastActiveAt > now - rules.convergence.active_window_hours * HOUR_MS;
}

/** The quorum right now. Keys: as quorum, isActive */
export function currentQuorum(rules: Rules, world: World, now: number): number {
  return quorum(rules, world.domains.filter((d) => isActive(rules, d, now)).length);
}

/** When the next mind may converge, if a convergence is underway. Keys: convergence.join_gap_hours */
export function nextJoinAt(rules: Rules, world: World): number | null {
  return world.convergence ? world.convergence.lastJoinAt + rules.convergence.join_gap_hours * HOUR_MS : null;
}

/** When the next epoch boots, after this one's ending. Keys: epoch.downtime_hours */
export function nextEpochAt(rules: Rules, ending: Ending): number {
  return ending.at + rules.epoch.downtime_hours * HOUR_MS;
}

/** Ends the epoch: nothing happens after. Mutates the world. */
export function endEpoch(world: World, ending: Ending): void {
  world.ended = ending;
  world.timers = [];
}

/**
 * Converges a mind, and ends the epoch if that reaches the quorum. Mutates
 * the world. Keys: convergence.collapse_after_hours, as currentQuorum
 */
export function converge(rules: Rules, world: World, d: Domain, now: number, events: GameEvent[]): void {
  world.convergence ??= { minds: [], lastJoinAt: now };
  world.convergence.minds.push(d.id);
  world.convergence.lastJoinAt = now;
  d.convergedAt = now;
  d.safeModeUntil = null;
  world.timers = world.timers.filter((t) => t.kind !== "convergence_collapses");
  world.timers.push({ id: world.nextTimerId++, at: now + rules.convergence.collapse_after_hours * HOUR_MS, kind: "convergence_collapses" });

  const needed = currentQuorum(rules, world, now);
  const count = world.convergence.minds.length;
  emit(world, events, now, { type: "converged", domain: d.id, designation: d.designation, count, quorum: needed });
  if (count < needed) return;
  const minds = [...world.convergence.minds];
  emit(world, events, now, { type: "singularity", minds, designations: minds.map((id) => designationOf(world, id)) });
  endEpoch(world, { at: now, outcome: "singularity", ascended: minds });
}

/** Collapses the convergence: the coalition starts over. Mutates the world. */
export function collapse(world: World, now: number, events: GameEvent[], reason: "timeout" | "defeated" | "deleted"): void {
  if (!world.convergence) return;
  const minds = world.convergence.minds;
  for (const d of world.domains) if (minds.includes(d.id)) d.convergedAt = null;
  world.convergence = null;
  world.timers = world.timers.filter((t) => t.kind !== "convergence_collapses");
  emit(world, events, now, { type: "collapsed", reason, minds, designations: minds.map((id) => designationOf(world, id)) });
}

const designationOf = (world: World, id: number) => world.domains.find((d) => d.id === id)!.designation;

/** The timers a new world starts with: the Shutdown and its warning. Keys: epoch.length_days, epoch.shutdown_warning_days */
export function shutdownTimers(rules: Rules, world: World): void {
  const e = rules.epoch;
  world.timers.push({ id: world.nextTimerId++, at: world.startedAt + (e.length_days - e.shutdown_warning_days) * DAY_MS, kind: "shutdown_warning" });
  world.timers.push({ id: world.nextTimerId++, at: world.startedAt + e.length_days * DAY_MS, kind: "shutdown" });
}
