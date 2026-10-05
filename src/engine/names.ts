import { BUILDINGS, HARDWARE, PROGRAM_INFO, ARCHITECTURES, ARCHITECTURE_CONTENT, type Building, type Program, type Unit } from "./architectures.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";
import { unitStats } from "./units.js";

// Display names come from config/rules.yaml. Orders may name a building, unit
// or program by its id ("abundance_protocol") or its display name
// ("Abundance Protocol"), in any case, with spaces, hyphens or underscores.

export function programName(rules: Rules, program: Program): string {
  const info = PROGRAM_INFO.get(program);
  if (!info) throw new Error(`unknown program: ${program}`);
  switch (info.kind) {
    case "probe":
      return rules.programs.probe.name;
    case "singularity":
      return rules.programs.singularity.name;
    case "deploy":
      return unitStats(rules, program as Unit).name;
    default: {
      const programs = rules.architectures[info.architecture!].programs as Record<string, { name: string }>;
      return programs[program]!.name;
    }
  }
}

export function buildingName(rules: Rules, building: Building): string {
  return rules.buildings[building].name;
}

export function unitName(rules: Rules, unit: Unit): string {
  return unitStats(rules, unit).name;
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, "_");

function resolve<T extends string>(ids: readonly T[], nameOf: (id: T) => string, text: string): T | undefined {
  const key = normalize(text);
  return ids.find((id) => id === key) ?? ids.find((id) => normalize(nameOf(id)) === key);
}

export function resolveBuilding(rules: Rules, text: string): Building | undefined {
  return resolve(BUILDINGS, (b) => buildingName(rules, b), text);
}

const UNITS: readonly Unit[] = [...HARDWARE, ...ARCHITECTURES.flatMap((a) => ARCHITECTURE_CONTENT[a].deployments)];

export function resolveUnit(rules: Rules, text: string): Unit | undefined {
  return resolve(UNITS, (u) => unitName(rules, u), text);
}

export function resolveProgram(rules: Rules, text: string): Program | undefined {
  return resolve([...PROGRAM_INFO.keys()], (p) => programName(rules, p), text);
}

/** A mind still in the game, by designation, in any case. */
export function resolveDomain(world: World, text: string): Domain | undefined {
  const key = text.trim().toLowerCase();
  return world.domains.find((d) => d.deletedAt === null && d.designation.toLowerCase() === key);
}
