import { DAY_MS, HOUR_MS } from "./cycles.js";
import { domainPower } from "./domain.js";
import { inRange } from "./power.js";
import { protocolShieldBecause } from "./protocols.js";
import { emit, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";

// The protection rules (DESIGN.md, Defense, protection, and deletion): the
// boot period, range and retaliation, safe mode and the hostile-program cap,
// and protocols (protocols.ts). Attacks and hostile programs pass the same
// check; Probe passes none. Converged minds lose range and safe-mode
// protection while their convergence lasts; protocols still hold.

const hours = (ms: number) => Math.max(1, Math.ceil(ms / HOUR_MS));

/** When a domain's boot period ends. Keys: protection.boot_hours */
export function bootPeriodEnds(rules: Rules, d: Domain): number {
  return d.bootedAt + rules.protection.boot_hours * HOUR_MS;
}

export function inSafeMode(d: Domain, now: number): boolean {
  return d.safeModeUntil !== null && now < d.safeModeUntil;
}

/** Whether `victim` was attacked or hit with a hostile program by `aggressor` recently. Keys: protection.retaliation_hours */
export function attackedBy(rules: Rules, victim: Domain, aggressor: Domain, now: number): boolean {
  const since = now - rules.protection.retaliation_hours * HOUR_MS;
  return victim.aggressors.some((a) => a.domain === aggressor.id && a.at > since);
}

/**
 * Why `actor` may not attack `target` or run a hostile program on it, or
 * undefined if it may. Keys: protection.*, as bootPeriodEnds, attackedBy, inRange, protocolShieldBecause
 */
export function shieldedBecause(rules: Rules, world: World, actor: Domain, target: Domain, now: number): string | undefined {
  const ownBoot = bootPeriodEnds(rules, actor);
  if (now < ownBoot) return `You're in your boot period for another ${hours(ownBoot - now)}h.`;
  return targetShieldedBecause(rules, world, actor, target, now);
}

/**
 * Why `target` is shielded from `actor`, leaving out the actor's own boot
 * period: what the brief's "in range" list needs. Keys: as shieldedBecause
 */
export function targetShieldedBecause(rules: Rules, world: World, actor: Domain, target: Domain, now: number): string | undefined {
  const theirBoot = bootPeriodEnds(rules, target);
  if (now < theirBoot) return `${target.designation} is in its boot period for another ${hours(theirBoot - now)}h.`;
  const protocol = protocolShieldBecause(rules, world, actor, target, now);
  if (protocol) return protocol;
  if (target.convergedAt !== null) return undefined;
  if (inSafeMode(target, now)) return `${target.designation} is in safe mode for another ${hours(target.safeModeUntil! - now)}h.`;
  const mine = domainPower(rules, actor);
  const theirs = domainPower(rules, target);
  if (!inRange(rules, mine, theirs) && !attackedBy(rules, actor, target, now)) {
    const p = rules.protection;
    return `${target.designation} is out of range: power ${theirs.toLocaleString("en-US")}, and you can reach ${p.range_min}× to ${p.range_max}× your ${mine.toLocaleString("en-US")}.`;
  }
  return undefined;
}

/** Notes that `aggressor` attacked or ran a hostile program on `victim`. Mutates the victim. Keys: as attackedBy */
export function noteAggression(rules: Rules, victim: Domain, aggressor: Domain, now: number): void {
  const since = now - rules.protection.retaliation_hours * HOUR_MS;
  victim.aggressors = victim.aggressors.filter((a) => a.at > since && a.domain !== aggressor.id);
  victim.aggressors.push({ domain: aggressor.id, at: now });
}

/** Attacking or running a hostile program gives up safe mode. Mutates the domain. */
export function leaveSafeMode(d: Domain): void {
  d.safeModeUntil = null;
}

/**
 * Notes a won attack on a domain; enough of them inside the window drop it
 * into safe mode. Mutates the world and the domain.
 * Keys: protection.safe_mode_hits, protection.safe_mode_window_hours, protection.safe_mode_hours
 */
export function noteHit(rules: Rules, world: World, d: Domain, now: number, events: GameEvent[]): void {
  const p = rules.protection;
  const since = now - p.safe_mode_window_hours * HOUR_MS;
  d.hits = [...d.hits.filter((t) => t > since), now];
  if (d.hits.length < p.safe_mode_hits || inSafeMode(d, now) || d.convergedAt !== null) return;
  d.hits = [];
  d.safeModeUntil = now + p.safe_mode_hours * HOUR_MS;
  emit(world, events, now, { type: "safe_mode", domain: d.id, designation: d.designation, until: d.safeModeUntil });
}

/** Hostile programs that reached a domain in the last day, blocked or not. */
export function hostileToday(d: Domain, now: number): number {
  return d.hostileReceived.filter((t) => t > now - DAY_MS).length;
}

/** Whether a domain has taken all the hostile programs it can today. Keys: protection.hostile_programs_per_target_per_day */
export function hostileCapReached(rules: Rules, d: Domain, now: number): boolean {
  return hostileToday(d, now) >= rules.protection.hostile_programs_per_target_per_day;
}

/** Notes a hostile program reaching a domain. Mutates the domain. */
export function noteHostile(d: Domain, now: number): void {
  d.hostileReceived = [...d.hostileReceived.filter((t) => t > now - DAY_MS), now];
}
