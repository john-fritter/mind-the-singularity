import { HARDWARE, type Program, type Unit } from "./architectures.js";
import { capability, isRunning } from "./domain.js";
import {
  buildingUpkeep,
  capitalIncome,
  computeIncome,
  computeStorage,
  researchIncome,
  shortfallLoss,
  userCap,
  userChange,
} from "./economy.js";
import { scaledEffect, researchCost } from "./programs.js";
import { emit, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";
import { forceTotals } from "./units.js";

// One cycle spent. DESIGN.md: "Every cycle spent, whatever it is spent on:
// income, users grow toward their cap, research progresses, upkeep is paid."
// Actions run first and the cycle's economy after, so a building finished
// this cycle earns this cycle. State stays in whole numbers: income and
// growth round down, upkeep rounds up.

/** Losses to unpaid upkeep, added up over an order so they make one event. */
export interface UpkeepLosses {
  abandoned: number;
  shutDown: number;
}

/**
 * Capital and compute one cycle earns, before rounding. Abundance Protocol
 * raises capital. Keys: as capitalIncome, computeIncome, and
 * architectures.symbiote.programs.abundance_protocol.capital_bonus
 */
export function cycleIncome(rules: Rules, domain: Domain, now: number): { capital: number; compute: number } {
  let capital = capitalIncome(rules, domain.users, domain.buildings.city);
  if (isRunning(domain, "abundance_protocol", now)) {
    const bonus = rules.architectures.symbiote.programs.abundance_protocol.capital_bonus;
    capital *= 1 + scaledEffect(rules, bonus, capability(domain));
  }
  return { capital, compute: computeIncome(rules, domain.buildings.datacenter) };
}

/**
 * User growth's multiplier this cycle. Keys:
 * architectures.symbiote.programs.abundance_protocol.user_growth_bonus
 */
function growthMultiplier(rules: Rules, domain: Domain, now: number): number {
  if (!isRunning(domain, "abundance_protocol", now)) return 1;
  const bonus = rules.architectures.symbiote.programs.abundance_protocol.user_growth_bonus;
  return 1 + scaledEffect(rules, bonus, capability(domain));
}

/** Adds compute, keeping it within storage. Keys: as computeStorage */
export function addCompute(rules: Rules, domain: Domain, amount: number): void {
  domain.compute = Math.min(computeStorage(rules, domain.buildings.datacenter), domain.compute + Math.floor(amount));
}

/** Learns a program. Mutates the world and the domain. */
export function learn(world: World, domain: Domain, program: Program, now: number, events: GameEvent[]): void {
  domain.known.push(program);
  delete domain.researchProgress[program];
  if (domain.researchTarget === program) domain.researchTarget = null;
  emit(world, events, now, { type: "learned", domain: domain.id, program });
}

/** Runs one cycle's economy on a domain. Mutates the world and the domain. */
export function passCycle(
  rules: Rules,
  world: World,
  domain: Domain,
  now: number,
  events: GameEvent[],
  losses: UpkeepLosses,
): void {
  // 1. Income.
  const income = cycleIncome(rules, domain, now);
  domain.capital += Math.floor(income.capital);
  addCompute(rules, domain, income.compute);

  // 2. Users move toward their cap.
  const cap = userCap(rules, domain.buildings.city, domain.territory);
  domain.users = Math.max(0, domain.users + Math.floor(userChange(rules, domain.users, cap, growthMultiplier(rules, domain, now))));

  // 3. Research.
  const target = domain.researchTarget;
  if (target && !domain.known.includes(target)) {
    const progress = (domain.researchProgress[target] ?? 0) + Math.floor(researchIncome(rules, domain.buildings.lab));
    if (progress >= researchCost(rules, target)) learn(world, domain, target, now, events);
    else domain.researchProgress[target] = progress;
  }

  // 4. Upkeep: capital for buildings and hardware, compute for deployments.
  // What can't be paid costs a share of the units it was for.
  const force = forceTotals(rules, domain.units);
  const capitalUpkeep = Math.ceil(buildingUpkeep(rules, domain.buildings) + force.capitalUpkeep);
  if (domain.capital >= capitalUpkeep) {
    domain.capital -= capitalUpkeep;
  } else {
    domain.capital = 0;
    for (const h of HARDWARE) losses.abandoned += loseShare(rules, domain, h);
  }
  const computeUpkeep = Math.ceil(force.computeUpkeep);
  if (domain.compute >= computeUpkeep) {
    domain.compute -= computeUpkeep;
  } else {
    domain.compute = 0;
    for (const unit of Object.keys(domain.units) as Unit[]) {
      if (!(HARDWARE as readonly string[]).includes(unit)) losses.shutDown += loseShare(rules, domain, unit);
    }
  }

  // 5. Programs that count the caster's cycles count this one.
  for (const r of domain.running) {
    if (r.cyclesLeft === undefined) continue;
    r.cyclesLeft--;
    if (r.cyclesLeft <= 0) emit(world, events, now, { type: "program_ended", domain: domain.id, program: r.program });
  }
  domain.running = domain.running.filter((r) => r.cyclesLeft === undefined || r.cyclesLeft > 0);
}

/** Removes the upkeep shortfall's share of one unit type. Returns how many. Keys: as shortfallLoss */
function loseShare(rules: Rules, domain: Domain, unit: Unit): number {
  const have = domain.units[unit] ?? 0;
  if (have === 0) return 0;
  const lost = Math.min(have, shortfallLoss(rules, have));
  domain.units[unit] = have - lost;
  return lost;
}

/** Emits one event for an order's upkeep losses, if there were any. */
export function reportUpkeepLosses(
  world: World,
  domain: Domain,
  now: number,
  events: GameEvent[],
  losses: UpkeepLosses,
): void {
  if (losses.abandoned === 0 && losses.shutDown === 0) return;
  emit(world, events, now, { type: "upkeep_unpaid", domain: domain.id, ...losses });
}
