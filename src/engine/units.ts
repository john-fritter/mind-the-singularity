import { ARCHITECTURE_CONTENT, ARCHITECTURES, HARDWARE, type Hardware, type Unit } from "./architectures.js";
import type { Rules } from "./rules.js";

// Unit stats, looked up by id across hardware and every architecture's
// deployments, and the totals a force adds up to.

export interface UnitStats {
  name: string;
  attack: number;
  defense: number;
  /** Per unit per cycle spent: capital for hardware, compute for deployments. */
  upkeep: number;
  ranged: boolean;
  kind: "hardware" | "deployment";
}

/** A unit's stats. Keys: hardware.<id>, architectures.<a>.deployments.<id> */
export function unitStats(rules: Rules, unit: Unit): UnitStats {
  if ((HARDWARE as readonly string[]).includes(unit)) {
    const h = rules.hardware[unit as Hardware];
    return { name: h.name, attack: h.attack, defense: h.defense, upkeep: h.upkeep, ranged: h.ranged, kind: "hardware" };
  }
  for (const a of ARCHITECTURES) {
    if ((ARCHITECTURE_CONTENT[a].deployments as readonly string[]).includes(unit)) {
      const d = (rules.architectures[a].deployments as Record<string, Omit<UnitStats, "kind">>)[unit]!;
      return { ...d, kind: "deployment" };
    }
  }
  throw new Error(`unknown unit: ${unit}`);
}

export interface ForceTotals {
  attack: number;
  defense: number;
  capitalUpkeep: number;
  computeUpkeep: number;
}

/** Base totals of a force, before programs and bonuses. */
export function forceTotals(rules: Rules, force: Partial<Record<Unit, number>>): ForceTotals {
  const t: ForceTotals = { attack: 0, defense: 0, capitalUpkeep: 0, computeUpkeep: 0 };
  for (const [unit, n] of Object.entries(force) as [Unit, number][]) {
    const s = unitStats(rules, unit);
    t.attack += n * s.attack;
    t.defense += n * s.defense;
    if (s.kind === "hardware") t.capitalUpkeep += n * s.upkeep;
    else t.computeUpkeep += n * s.upkeep;
  }
  return t;
}
