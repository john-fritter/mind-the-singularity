import type { Building } from "./architectures.js";
import type { Rules } from "./rules.js";

// The per-cycle economy and the growth actions: what one cycle spent yields,
// what expanding and building give and cost. Counts (sectors, buildings,
// units) come back as integers; amounts of capital, compute, users and
// research come back exact, and the engine rounds them down where it writes
// state. Costs are rounded up.

/** Sectors one Expand gains. Keys: expansion.* */
export function expansionYield(rules: Rules, territory: number): number {
  const e = rules.expansion;
  const raw = e.yield_base * (e.yield_reference_territory / territory) ** e.yield_falloff;
  return Math.max(e.yield_min, Math.floor(raw));
}

/** Buildings one Build batch can place. Keys: build.rate_base, build.rate_sectors_per_extra */
export function buildRate(rules: Rules, territory: number): number {
  return rules.build.rate_base + Math.floor(territory / rules.build.rate_sectors_per_extra);
}

/** Capital to build one building. Keys: buildings.<id>.capital, build.cost_territory_scale */
export function buildingCost(rules: Rules, building: Building, territory: number): number {
  return Math.ceil(rules.buildings[building].capital * (1 + territory / rules.build.cost_territory_scale));
}

/** Capital per cycle spent for all buildings. Keys: buildings.<id>.upkeep */
export function buildingUpkeep(rules: Rules, buildings: Record<Building, number>): number {
  let total = 0;
  for (const [b, n] of Object.entries(buildings) as [Building, number][]) total += n * rules.buildings[b].upkeep;
  return total;
}

/** The most users a domain can hold. Keys: users.per_city, users.per_sector */
export function userCap(rules: Rules, cities: number, territory: number): number {
  return cities * rules.users.per_city + territory * rules.users.per_sector;
}

/**
 * How users change in one cycle: growth toward the cap below it, shrinkage
 * above it. growthMultiplier is 1 unless a program boosts or stalls growth.
 * Keys: users.growth_rate, users.shrink_rate
 */
export function userChange(rules: Rules, users: number, cap: number, growthMultiplier = 1): number {
  if (users > cap) return -(users - cap) * rules.users.shrink_rate;
  return (cap - users) * rules.users.growth_rate * growthMultiplier;
}

/** Capital income per cycle spent. Keys: economy.capital_per_user, economy.capital_per_city */
export function capitalIncome(rules: Rules, users: number, cities: number): number {
  return users * rules.economy.capital_per_user + cities * rules.economy.capital_per_city;
}

/** Compute income per cycle spent. Keys: economy.compute_per_datacenter */
export function computeIncome(rules: Rules, datacenters: number): number {
  return datacenters * rules.economy.compute_per_datacenter;
}

/** The most compute a domain can store. Keys: economy.compute_storage_base, economy.compute_storage_per_datacenter */
export function computeStorage(rules: Rules, datacenters: number): number {
  return rules.economy.compute_storage_base + datacenters * rules.economy.compute_storage_per_datacenter;
}

/** Research points per cycle spent. Keys: research.per_lab */
export function researchIncome(rules: Rules, labs: number): number {
  return labs * rules.research.per_lab;
}

/** Extra capital from one Monetize, given a cycle's capital income. Keys: economy.monetize_income_multiple */
export function monetizeYield(rules: Rules, capitalPerCycle: number): number {
  return capitalPerCycle * rules.economy.monetize_income_multiple;
}

/** Extra compute from one Spin Up, given a cycle's compute income. Keys: economy.spin_up_income_multiple */
export function spinUpYield(rules: Rules, computePerCycle: number): number {
  return computePerCycle * rules.economy.spin_up_income_multiple;
}

/** Hardware units the factories can house. Keys: manufacture.housing_per_factory */
export function hardwareHousing(rules: Rules, factories: number): number {
  return factories * rules.manufacture.housing_per_factory;
}

/** Hardware units one Manufacture batch can make. Keys: manufacture.per_factory_per_batch */
export function manufactureCapacity(rules: Rules, factories: number): number {
  return factories * rules.manufacture.per_factory_per_batch;
}

/**
 * Units lost to one cycle of unpaid upkeep, out of `units`. Hardware is lost
 * when capital runs short, deployments when compute does.
 * Keys: economy.shortfall_loss_share
 */
export function shortfallLoss(rules: Rules, units: number): number {
  return Math.ceil(units * rules.economy.shortfall_loss_share);
}
