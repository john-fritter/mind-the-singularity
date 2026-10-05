import type { Rules } from "./rules.js";
import type { Domain } from "./state.js";

// Cycles without a tick. A domain accrues one cycle per interval since it
// booted, on a fixed grid, so a part-finished interval is never lost when the
// balance is read or spent. The stored balance is synced (the ticks since
// the last sync counted in, anything past the cap lost) only when cycles are
// spent; reads compute it.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Accrual ticks since boot, at a moment. Keys: cycles.interval_minutes */
export function cycleTicks(rules: Rules, domain: Domain, now: number): number {
  return Math.max(0, Math.floor((now - domain.bootedAt) / (rules.cycles.interval_minutes * MINUTE_MS)));
}

/** Cycles available at a moment. Keys: cycles.cap, as cycleTicks */
export function availableCycles(rules: Rules, domain: Domain, now: number): number {
  const accrued = cycleTicks(rules, domain, now) - domain.cycleTicks;
  return Math.min(rules.cycles.cap, domain.cycles + accrued);
}

/** Cycles lost to the cap up to a moment. Keys: as availableCycles */
export function wastedCycles(rules: Rules, domain: Domain, now: number): number {
  const accrued = cycleTicks(rules, domain, now) - domain.cycleTicks;
  return domain.cyclesWasted + Math.max(0, domain.cycles + accrued - rules.cycles.cap);
}

/** Counts accrued cycles into the stored balance. Mutates the domain. */
export function syncCycles(rules: Rules, domain: Domain, now: number): void {
  domain.cyclesWasted = wastedCycles(rules, domain, now);
  domain.cycles = availableCycles(rules, domain, now);
  domain.cycleTicks = cycleTicks(rules, domain, now);
}

/** The cycles a new domain starts with. Keys: cycles.start_full, cycles.cap */
export function startingCycles(rules: Rules): number {
  return rules.cycles.start_full ? rules.cycles.cap : 0;
}
