import type { Rules } from "./rules.js";

// Power: the one public score. It ranks domains and decides who may attack
// whom.

export interface PowerInput {
  territory: number;
  /** All buildings, cores included. */
  buildings: number;
  /** Base attack and defense of all units, without programs or bonuses. */
  attack: number;
  defense: number;
  capability: number;
}

/** A domain's power, rounded down. Keys: power.* */
export function power(rules: Rules, d: PowerInput): number {
  const p = rules.power;
  return Math.floor(
    d.territory * p.per_sector +
      d.buildings * p.per_building +
      (d.attack + d.defense) * p.per_force_point +
      d.capability * p.per_capability,
  );
}

/**
 * Whether the target's power is within the attacker's range. Retaliation,
 * boot periods and safe mode are checked by the engine, not here.
 * Keys: protection.range_min, protection.range_max
 */
export function inRange(rules: Rules, attackerPower: number, targetPower: number): boolean {
  return (
    targetPower >= attackerPower * rules.protection.range_min &&
    targetPower <= attackerPower * rules.protection.range_max
  );
}
