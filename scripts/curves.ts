/**
 * Prints the main curves from config/rules.yaml, and a rough projection of
 * one domain growing alone, so a change to the numbers can be eyeballed
 * before the simulator exists.
 *
 * Usage: npm run curves
 *
 * The projection is a crude solo player: no combat, no programs, no other
 * minds. It splits its cycles by a fixed PLAN between expanding, building (in
 * a fixed MIX), manufacturing, and "other", which stands in for executing,
 * attacking, Monetize and Spin Up and is counted as Monetize and Spin Up in
 * turn. PLAN and MIX are
 * assumptions of this script, not game numbers. Phase 2's simulator replaces
 * it.
 */

import { loadRules } from "../src/config.js";
import { BUILDINGS, programsOf, type Building } from "../src/engine/architectures.js";
import { battleOutcome } from "../src/engine/combat.js";
import {
  buildingCost,
  buildingUpkeep,
  buildRate,
  capitalIncome,
  computeIncome,
  computeStorage,
  expansionYield,
  hardwareHousing,
  manufactureCapacity,
  researchIncome,
  spinUpYield,
  userCap,
  userChange,
} from "../src/engine/economy.js";
import { power } from "../src/engine/power.js";
import { crashChance, deployCount, researchCost } from "../src/engine/programs.js";
import { forceTotals } from "../src/engine/units.js";

const rules = loadRules();

const MIX: Record<Building, number> = { city: 0.3, datacenter: 0.25, factory: 0.15, lab: 0.2, core: 0.04, firewall: 0.06 };
/** How the projection's player means to split its cycles. */
const PLAN = { expand: 0.3, build: 0.2, manufacture: 0.15, other: 0.35 };
const REPORT_DAYS = [1, 2, 5, 12, 20, 30, 45, 60];

function table(title: string, header: string[], rows: (string | number)[][]) {
  console.log(`\n${title}`);
  const cells = [header, ...rows.map((r) => r.map((c) => (typeof c === "number" ? fmt(c) : c)))];
  const widths = header.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  for (const r of cells) console.log("  " + r.map((c, i) => c.padStart(widths[i]!)).join("  "));
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(Math.abs(n) < 1 ? 3 : 1);
}

function curves() {
  table(
    "Growth by territory",
    ["territory", "expand yield", "build rate", "city cost", "user cap (no cities)"],
    [250, 500, 800, 1250, 2000, 3000, 5000].map((t) => [
      t,
      expansionYield(rules, t),
      buildRate(rules, t),
      buildingCost(rules, "city", t),
      userCap(rules, 0, t),
    ]),
  );

  table(
    "Programs by capability",
    ["capability", "crash t1", "crash t2", "crash t3", "deploy t1", "deploy t2", "deploy t3"],
    [0, 1, 2, 4, 6, 8].map((c) => [
      c,
      crashChance(rules, 1, c),
      crashChance(rules, 2, c),
      crashChance(rules, 3, c),
      deployCount(rules, 1, c),
      deployCount(rules, 2, c),
      deployCount(rules, 3, c),
    ]),
  );

  table(
    "Battle losses by strength ratio (attacker wins)",
    ["ratio", "attacker loses", "defender loses", "lopsided"],
    [1.01, 1.1, 1.25, 1.5, 2, 3, 5].map((r) => {
      const o = battleOutcome(rules, 1000 * r, 1000);
      return [r, o.attackerLoss, o.defenderLoss, o.lopsided ? "yes" : ""];
    }),
  );

  const path = programsOf("steward").reduce((sum, p) => sum + researchCost(rules, p.id), 0);
  console.log(`\nResearch to know all eight programs, the Singularity included: ${fmt(path)} points`);
}

function projection() {
  const s = rules.start;
  const d = {
    territory: s.territory,
    buildings: { ...s.buildings },
    users: s.users,
    capital: s.capital,
    compute: s.compute,
    research: 0,
    hardware: { ...s.hardware },
  };
  const built = () => Object.values(d.buildings).reduce((a, b) => a + b, 0);
  const housed = () => Object.values(d.hardware).reduce((a, b) => a + b, 0);
  const planned = { expand: 0, build: 0, manufacture: 0, other: 0 };
  const spent = { expand: 0, build: 0, manufacture: 0, other: 0 };
  const rows: (string | number)[][] = [];
  const path = programsOf("steward").reduce((sum, p) => sum + researchCost(rules, p.id), 0);
  let pathDay: number | undefined;

  for (let cycle = 1; cycle <= rules.epoch.length_days * 48; cycle++) {
    // Every cycle spent: income, user growth, research, upkeep.
    const cap = userCap(rules, d.buildings.city, d.territory);
    d.users = Math.floor(d.users + userChange(rules, d.users, cap));
    const income = capitalIncome(rules, d.users, d.buildings.city);
    const force = forceTotals(rules, d.hardware);
    d.capital = Math.floor(d.capital + income - buildingUpkeep(rules, d.buildings) - force.capitalUpkeep);
    const storage = computeStorage(rules, d.buildings.datacenter);
    d.compute = Math.min(storage, Math.floor(d.compute + computeIncome(rules, d.buildings.datacenter)));
    d.research += researchIncome(rules, d.buildings.lab);
    if (pathDay === undefined && d.research >= path) pathDay = cycle / 48;

    // The action this cycle is spent on: whichever is furthest behind PLAN,
    // falling back to expanding when it can't build and to "other" when it
    // can't manufacture.
    const action = (Object.keys(PLAN) as (keyof typeof PLAN)[]).reduce((best, a) =>
      PLAN[a] * cycle - planned[a] > PLAN[best] * cycle - planned[best] ? a : best,
    );
    planned[action]++;
    const rate = buildRate(rules, d.territory);
    const room = Math.min(rate, d.territory - built());
    const h = rules.hardware;
    const batch = Math.min(manufactureCapacity(rules, d.buildings.factory), hardwareHousing(rules, d.buildings.factory) - housed());
    const [drones, sentries] = [Math.ceil(batch / 2), Math.floor(batch / 2)];
    const batchCost = drones * h.drones.capital + sentries * h.sentries.capital;

    const nextBuilding = () => {
      const total = built() + 1;
      return BUILDINGS.reduce((best, b) => (MIX[b] * total - d.buildings[b] > MIX[best] * total - d.buildings[best] ? b : best));
    };
    if (action === "build" && room > 0 && d.capital >= buildingCost(rules, nextBuilding(), d.territory)) {
      spent.build++;
      for (let i = 0; i < room; i++) {
        const next = nextBuilding();
        const cost = buildingCost(rules, next, d.territory);
        if (d.capital < cost) break;
        d.capital -= cost;
        d.buildings[next]++;
      }
    } else if (action === "build" || action === "expand") {
      spent.expand++;
      d.territory += expansionYield(rules, d.territory);
    } else if (action === "manufacture" && batch > 0 && d.capital >= batchCost) {
      spent.manufacture++;
      d.hardware.drones += drones;
      d.hardware.sentries += sentries;
      d.capital -= batchCost;
      d.users -= drones * h.drones.users + sentries * h.sentries.users;
    } else {
      // Standing in for executing, attacking, Monetize and Spin Up: counted
      // as Monetize and Spin Up in turn.
      spent.other++;
      if (spent.other % 2) d.capital += Math.floor(income * rules.economy.monetize_income_multiple);
      else d.compute = Math.min(storage, Math.floor(d.compute + spinUpYield(rules, computeIncome(rules, d.buildings.datacenter))));
    }

    if (cycle % 48 === 0 && REPORT_DAYS.includes(cycle / 48)) {
      const f = forceTotals(rules, d.hardware);
      rows.push([
        cycle / 48,
        d.territory,
        built(),
        `${fmt(d.users)}/${fmt(cap)}`,
        Math.floor(income),
        d.capital,
        `${fmt(d.compute)}/${fmt(storage)}`,
        d.research,
        power(rules, { territory: d.territory, buildings: built(), attack: f.attack, defense: f.defense, capability: 0 }),
      ]);
    }
  }

  const share = (n: number) => `${Math.round((100 * n) / (rules.epoch.length_days * 48))}%`;
  table(
    "Projection: one domain alone, a crude player spending every cycle",
    ["day", "territory", "built", "users/cap", "capital/cycle", "capital", "compute/storage", "research", "power"],
    rows,
  );
  console.log(`  plan: ${Object.entries(PLAN).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}`);
  console.log(`  spent: ${Object.entries(spent).map(([k, v]) => `${k} ${share(v)}`).join(", ")}`);
  console.log(`  buildings in the mix: ${BUILDINGS.map((b) => `${b} ${Math.round(MIX[b] * 100)}%`).join(", ")}`);
  console.log(`  research for all eight programs reached on day ${pathDay === undefined ? "never" : fmt(pathDay)}`);
}

function main() {
  curves();
  projection();
}

main();
