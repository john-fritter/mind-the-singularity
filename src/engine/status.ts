import type { Architecture, Building, Program, Unit } from "./architectures.js";
import { availableCycles } from "./cycles.js";
import { capability, domainPower } from "./domain.js";
import type { Rules } from "./rules.js";
import type { Domain, RunningProgram } from "./state.js";

// A domain's full status: what Probe reveals. Everything but the scratchpad,
// which is the mind's own.

export interface DomainStatus {
  designation: string;
  domainName: string;
  architecture: Architecture;
  power: number;
  capability: number;
  cycles: number;
  territory: number;
  buildings: Record<Building, number>;
  capital: number;
  compute: number;
  users: number;
  units: Partial<Record<Unit, number>>;
  known: Program[];
  researchTarget: Program | null;
  running: RunningProgram[];
  countermeasure: { program: Program; above: number } | null;
  safeModeUntil: number | null;
  convergedAt: number | null;
}

/** A domain's full status at a moment. */
export function domainStatus(rules: Rules, d: Domain, now: number): DomainStatus {
  return structuredClone({
    designation: d.designation,
    domainName: d.domainName,
    architecture: d.architecture,
    power: domainPower(rules, d),
    capability: capability(d),
    cycles: availableCycles(rules, d, now),
    territory: d.territory,
    buildings: d.buildings,
    capital: d.capital,
    compute: d.compute,
    users: d.users,
    units: d.units,
    known: d.known,
    researchTarget: d.researchTarget,
    running: d.running.filter((r) => r.endsAt === undefined || r.endsAt > now),
    countermeasure: d.countermeasure,
    safeModeUntil: d.safeModeUntil !== null && d.safeModeUntil > now ? d.safeModeUntil : null,
    convergedAt: d.convergedAt,
  });
}
