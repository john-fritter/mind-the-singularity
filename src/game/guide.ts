import { BUILDINGS, HARDWARE, programsOf, type Building, type Program } from "../engine/architectures.js";
import { coreBonus } from "../engine/combat.js";
import { cycleIncome } from "../engine/cycle.js";
import { availableCycles, cycleTicks, MINUTE_MS } from "../engine/cycles.js";
import {
  buildingCost,
  buildingUpkeep,
  buildRate,
  computeStorage,
  expansionYield,
  hardwareHousing,
  manufactureCapacity,
  monetizeYield,
  researchIncome,
  spinUpYield,
  userCap,
  userChange,
} from "../engine/economy.js";
import { buildingName, programName } from "../engine/names.js";
import { firewallBlockChance, programCompute, researchCost } from "../engine/programs.js";
import type { Rules } from "../engine/rules.js";
import type { Domain } from "../engine/state.js";
import { forceTotals } from "../engine/units.js";
import { programText } from "./handbook.js";

// What each order would do for this mind right now, for the dashboard's
// forms: "Expand: +9 sectors", "Build: up to 10, a city costs 244". Worked
// out from the mind's own domain with the engine's formulas, so it is only
// what the rules and the brief already say, added up. It changes nothing.

export interface DomainRow {
  id: Building | "territory" | "open";
  name: string;
  count: number;
  /** What one gives. */
  each: string;
  /** What they give in all, or "" when the sum says nothing more. */
  total: string;
}

export interface Priced {
  id: string;
  name: string;
  /** "City · 244 capital". */
  label: string;
}

export interface Guide {
  /** When the cycle store fills and new cycles start to be wasted, or null when it is full. Keys: cycles.* */
  cyclesFullAt: number | null;
  cycleMinutes: number;
  /** Cycles each action costs. Keys: action_cycles */
  costs: Rules["action_cycles"];
  /** One cycle spent, on anything. */
  perCycle: { capital: number; compute: number; capitalUpkeep: number; computeUpkeep: number; users: number; research: number };
  domain: DomainRow[];
  expand: { sectors: number; userCap: number; floor: number };
  build: { batch: number; open: number; buildings: Priced[] };
  manufacture: { batch: number; room: number; hardware: Priced[] };
  monetize: number;
  spinUp: number;
  computeStorage: number;
  /** Research targets, with progress and what each does. */
  research: (Priced & { does: string })[];
  /** Programs known that execute runs, with their cost and effect. */
  execute: (Priced & { does: string })[];
  /** Battle programs known, for an attack or a countermeasure. */
  battle: (Priced & { does: string })[];
}

const n = (x: number) => Math.floor(x).toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;

function rows(rules: Rules, d: Domain): DomainRow[] {
  const b = d.buildings;
  const e = rules.economy;
  const built = BUILDINGS.reduce((s, k) => s + b[k], 0);
  const hardware = HARDWARE.reduce((s, h) => s + (d.units[h] ?? 0), 0);
  const name = (k: Building) => buildingName(rules, k);
  return [
    { id: "territory", name: "Territory", count: d.territory, each: `${rules.users.per_sector} user cap a sector`, total: `${n(d.territory * rules.users.per_sector)} user cap` },
    { id: "city", name: name("city"), count: b.city, each: `${rules.users.per_city} user cap, ${n(e.capital_per_city)} capital a cycle`, total: `${n(b.city * rules.users.per_city)} user cap · ${n(b.city * e.capital_per_city)} capital` },
    {
      id: "datacenter",
      name: name("datacenter"),
      count: b.datacenter,
      each: `${n(e.compute_per_datacenter)} compute a cycle, ${e.compute_storage_per_datacenter} storage`,
      total: `${n(b.datacenter * e.compute_per_datacenter)} compute · ${n(computeStorage(rules, b.datacenter))} storage`,
    },
    {
      id: "factory",
      name: name("factory"),
      count: b.factory,
      each: `houses ${rules.manufacture.housing_per_factory} hardware, makes ${rules.manufacture.per_factory_per_batch} a batch`,
      total: `${n(hardware)} of ${n(hardwareHousing(rules, b.factory))} housed · ${n(manufactureCapacity(rules, b.factory))} a batch`,
    },
    { id: "lab", name: name("lab"), count: b.lab, each: `${n(rules.research.per_lab)} research point a cycle`, total: `${n(researchIncome(rules, b.lab))} points a cycle` },
    { id: "core", name: name("core"), count: b.core, each: "defense bonus; lose them all and you are deleted", total: `+${pct(coreBonus(rules, b.core) - 1)} defense` },
    { id: "firewall", name: name("firewall"), count: b.firewall, each: "blocks hostile programs", total: `${pct(firewallBlockChance(rules, b.firewall, d.territory))} chance to block` },
    { id: "open", name: "Open land", count: d.territory - built, each: "room for a building", total: "" },
  ];
}

function described(rules: Rules, p: Program, label: string): Priced & { does: string } {
  return { id: p, name: programName(rules, p), label, does: programText(rules, p) };
}

/** The guide for a domain at a moment (the domain settled to that moment). */
export function guide(rules: Rules, d: Domain, now: number): Guide {
  const income = cycleIncome(rules, d, now);
  const force = forceTotals(rules, d.units);
  const cap = userCap(rules, d.buildings.city, d.territory);
  const interval = rules.cycles.interval_minutes * MINUTE_MS;
  const have = availableCycles(rules, d, now);
  const sectors = expansionYield(rules, d.territory);
  const built = BUILDINGS.reduce((s, k) => s + d.buildings[k], 0);
  const housed = HARDWARE.reduce((s, h) => s + (d.units[h] ?? 0), 0);
  const programs = programsOf(d.architecture);
  const known = new Set(d.known);
  return {
    cyclesFullAt: have >= rules.cycles.cap ? null : d.bootedAt + (cycleTicks(rules, d, now) + rules.cycles.cap - have) * interval,
    cycleMinutes: rules.cycles.interval_minutes,
    costs: rules.action_cycles,
    perCycle: {
      capital: Math.floor(income.capital),
      compute: Math.floor(income.compute),
      capitalUpkeep: Math.ceil(buildingUpkeep(rules, d.buildings) + force.capitalUpkeep),
      computeUpkeep: Math.ceil(force.computeUpkeep),
      users: Math.floor(userChange(rules, d.users, cap)),
      research: researchIncome(rules, d.buildings.lab),
    },
    domain: rows(rules, d),
    expand: { sectors, userCap: sectors * rules.users.per_sector, floor: rules.expansion.yield_min },
    build: {
      batch: buildRate(rules, d.territory),
      open: d.territory - built,
      buildings: BUILDINGS.map((b) => {
        const cost = buildingCost(rules, b, d.territory);
        return { id: b, name: buildingName(rules, b), label: `${buildingName(rules, b)} · ${n(cost)} capital` };
      }),
    },
    manufacture: {
      batch: manufactureCapacity(rules, d.buildings.factory),
      room: Math.max(0, hardwareHousing(rules, d.buildings.factory) - housed),
      hardware: HARDWARE.map((h) => {
        const u = rules.hardware[h];
        return { id: h, name: u.name, label: `${u.name} · ${n(u.capital)} capital, ${n(u.users)} user${u.users === 1 ? "" : "s"} · attack ${n(u.attack)}, defense ${n(u.defense)}` };
      }),
    },
    monetize: Math.floor(monetizeYield(rules, income.capital)),
    spinUp: Math.floor(spinUpYield(rules, income.compute)),
    computeStorage: computeStorage(rules, d.buildings.datacenter),
    research: programs
      .filter((p) => !known.has(p.id) && (p.kind !== "singularity" || known.size === programs.length - 1))
      .map((p) => described(rules, p.id, `${programName(rules, p.id)} · ${n(d.researchProgress[p.id] ?? 0)} of ${n(researchCost(rules, p.id))}`)),
    execute: programs
      .filter((p) => known.has(p.id) && p.kind !== "battle")
      .map((p) => described(rules, p.id, `${programName(rules, p.id)} · ${n(programCompute(rules, p.id))} compute`)),
    battle: programs.filter((p) => known.has(p.id) && p.kind === "battle").map((p) => described(rules, p.id, `${programName(rules, p.id)} · ${n(programCompute(rules, p.id))} compute`)),
  };
}
