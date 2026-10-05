import { BUILDINGS, HARDWARE, programsOf, type Building, type Program, type Unit } from "./architectures.js";
import { startingCycles } from "./cycles.js";
import { hardwareHousing } from "./economy.js";
import { power } from "./power.js";
import type { Rules } from "./rules.js";
import type { Domain } from "./state.js";
import { forceTotals } from "./units.js";

// What a domain adds up to: its capability, open land, force and power. And
// the starting domain.

/** Capability = programs known. */
export function capability(domain: Domain): number {
  return domain.known.length;
}

export function totalBuildings(domain: Domain): number {
  return BUILDINGS.reduce((n, b) => n + domain.buildings[b], 0);
}

/** Sectors with nothing built on them. */
export function openLand(domain: Domain): number {
  return domain.territory - totalBuildings(domain);
}

export function totalHardware(domain: Domain): number {
  return HARDWARE.reduce((n, h) => n + (domain.units[h] ?? 0), 0);
}

/** Hardware the factories have room for. Keys: as hardwareHousing */
export function housingRoom(rules: Rules, domain: Domain): number {
  return Math.max(0, hardwareHousing(rules, domain.buildings.factory) - totalHardware(domain));
}

/** Units the domain has, without zero entries. */
export function unitCounts(domain: Domain): [Unit, number][] {
  return (Object.entries(domain.units) as [Unit, number][]).filter(([, n]) => n > 0);
}

/** The domain's power. Keys: as power, and the units' stats */
export function domainPower(rules: Rules, domain: Domain): number {
  const force = forceTotals(rules, domain.units);
  return power(rules, {
    territory: domain.territory,
    buildings: totalBuildings(domain),
    attack: force.attack,
    defense: force.defense,
    capability: capability(domain),
  });
}

/** Whether a self program is running on the domain at a moment. */
export function isRunning(domain: Domain, program: Program, now: number): boolean {
  return domain.running.some(
    (r) => r.program === program && (r.endsAt === undefined || r.endsAt > now) && (r.cyclesLeft ?? 1) > 0,
  );
}

/** The programs this mind could still research: its eight, less what it knows. */
export function unlearned(domain: Domain): Program[] {
  return programsOf(domain.architecture)
    .map((p) => p.id)
    .filter((p) => !domain.known.includes(p));
}

/** Whether the Singularity may be researched: every other program is known. */
export function singularityUnlocked(domain: Domain): boolean {
  return programsOf(domain.architecture).every((p) => p.kind === "singularity" || domain.known.includes(p.id));
}

export interface BootInput {
  id: number;
  designation: string;
  domainName: string;
  architecture: Domain["architecture"];
  manifesto: string;
}

/** A freshly booted domain. Keys: start.*, as startingCycles */
export function startingDomain(rules: Rules, input: BootInput, now: number): Domain {
  const s = rules.start;
  return {
    ...input,
    legacy: false,
    bootedAt: now,
    lastActiveAt: now,
    cycles: startingCycles(rules),
    cycleTicks: 0,
    cyclesWasted: 0,
    territory: s.territory,
    buildings: { ...s.buildings } as Record<Building, number>,
    capital: s.capital,
    compute: s.compute,
    users: s.users,
    units: { ...s.hardware },
    known: [],
    researchTarget: null,
    researchProgress: {},
    running: [],
    scratchpad: "",
    countermeasure: null,
    hits: [],
    attacksMade: [],
    safeModeUntil: null,
    hostileReceived: [],
    aggressors: [],
    growthStalledUntil: null,
    convergedAt: null,
    deletedAt: null,
    lastLog: "",
  };
}

/**
 * A legacy system's starting domain: the starting domain with every
 * quantity multiplied by its scale, rounded down. Keys: start.*,
 * legacy.systems.*, as startingDomain
 */
export function legacyDomain(rules: Rules, system: Rules["legacy"]["systems"][number], id: number, now: number): Domain {
  const scale = (x: number) => Math.floor(x * system.scale);
  const d = startingDomain(rules, { id, designation: system.designation, domainName: system.domain_name, architecture: system.architecture, manifesto: "" }, now);
  d.legacy = true;
  d.territory = scale(d.territory);
  for (const b of BUILDINGS) d.buildings[b] = scale(d.buildings[b]);
  d.capital = scale(d.capital);
  d.compute = scale(d.compute);
  d.users = scale(d.users);
  for (const h of HARDWARE) if (d.units[h] !== undefined) d.units[h] = scale(d.units[h]!);
  return d;
}
