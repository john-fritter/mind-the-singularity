import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import {
  ARCHITECTURE_CONTENT,
  ARCHITECTURES,
  HARDWARE,
  opposes,
  PROGRAM_INFO,
  programsOf,
  wheelDistance,
} from "../src/engine/architectures.js";
import {
  battleOutcome,
  conquestScale,
  conquestSectors,
  lopsidedCores,
  coreBonus,
  opposingBonus,
  raidSpoils,
  randomFactor,
  unitsLost,
} from "../src/engine/combat.js";
import { quorum } from "../src/engine/convergence.js";
import {
  buildingCost,
  buildRate,
  capitalIncome,
  computeIncome,
  computeStorage,
  expansionYield,
  hardwareHousing,
  manufactureCapacity,
  userCap,
  userChange,
} from "../src/engine/economy.js";
import { inRange, power } from "../src/engine/power.js";
import {
  crashChance,
  deployCount,
  firewallBlockChance,
  programCompute,
  programCrashChance,
  programTier,
  researchCost,
  scaledShare,
} from "../src/engine/programs.js";
import { forceTotals, unitStats } from "../src/engine/units.js";

// The formulas in src/engine/ against the real config/rules.yaml: a few values
// worked by hand, and the shapes the design depends on (yields fall, chances
// stay chances, the winner loses less). When a number in the config changes,
// the hand-worked values here may need to follow; the shapes shouldn't.

const rules = loadRules();
const MAX_CAPABILITY = programsOf("steward").length;

/** True when f never rises across xs. */
const nonincreasing = (xs: number[], f: (x: number) => number) => xs.every((x, i) => i === 0 || f(x) <= f(xs[i - 1]!));
const nondecreasing = (xs: number[], f: (x: number) => number) => xs.every((x, i) => i === 0 || f(x) >= f(xs[i - 1]!));
const TERRITORIES = [1, 50, 100, 250, 400, 500, 800, 1250, 2000, 5000, 20000, 100000];
const CAPABILITIES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function structure() {
  // Every architecture has two neighbors and two opposites, symmetrically.
  for (const a of ARCHITECTURES) {
    assert.equal(wheelDistance(a, a), 0);
    assert.equal(ARCHITECTURES.filter((b) => opposes(a, b)).length, 2, `${a} has two opposites`);
    for (const b of ARCHITECTURES) assert.equal(opposes(a, b), opposes(b, a));
  }
  assert.ok(opposes("steward", "accelerant") && opposes("steward", "assimilator"));
  assert.ok(!opposes("steward", "symbiote") && !opposes("steward", "oracle"));

  // Eight programs per mind; 30 architecture programs plus 2 universal.
  assert.equal(MAX_CAPABILITY, 8);
  assert.equal(PROGRAM_INFO.size, 32);

  // Every unit has stats, and every program a tier (but the Singularity),
  // a research cost and a compute cost.
  for (const u of HARDWARE) assert.equal(unitStats(rules, u).kind, "hardware");
  for (const a of ARCHITECTURES) {
    for (const d of ARCHITECTURE_CONTENT[a].deployments) assert.equal(unitStats(rules, d).kind, "deployment");
    for (const p of programsOf(a)) {
      assert.ok(researchCost(rules, p.id) > 0, `${p.id} has a research cost`);
      assert.ok(programCompute(rules, p.id) >= 0, `${p.id} has a compute cost`);
      if (p.kind !== "singularity") assert.ok(programTier(rules, p.id), `${p.id} has a tier`);
    }
  }
  assert.throws(() => unitStats(rules, "unicorns" as never), /unknown unit/);
}

function economy() {
  // Expansion: 10 at the start, falling as the domain grows, never below the minimum.
  assert.equal(expansionYield(rules, 250), 10);
  assert.equal(expansionYield(rules, 500), 6, "the floor");
  assert.equal(expansionYield(rules, 1250), 6, "the floor");
  assert.equal(expansionYield(rules, 100000), rules.expansion.yield_min);
  assert.ok(nonincreasing(TERRITORIES, (t) => expansionYield(rules, t)));
  assert.ok(TERRITORIES.every((t) => Number.isInteger(expansionYield(rules, t))));

  // Building: rate grows with territory, and so does cost.
  assert.equal(buildRate(rules, 250), 10);
  assert.ok(nondecreasing(TERRITORIES, (t) => buildRate(rules, t)));
  assert.equal(buildingCost(rules, "city", 250), 240);
  assert.equal(buildingCost(rules, "core", 250), 1500);
  assert.ok(nondecreasing(TERRITORIES, (t) => buildingCost(rules, "lab", t)));

  // The starting domain's numbers.
  const s = rules.start;
  assert.equal(userCap(rules, s.buildings.city, s.territory), 5500);
  assert.equal(capitalIncome(rules, s.users, s.buildings.city), 300);
  assert.equal(computeIncome(rules, s.buildings.datacenter), 90);
  assert.equal(computeStorage(rules, s.buildings.datacenter), 2200);
  assert.equal(hardwareHousing(rules, s.buildings.factory), 500);
  assert.equal(manufactureCapacity(rules, s.buildings.factory), 20);

  // Users move toward the cap from either side and never overshoot it.
  for (const users of [0, 1000, 5499, 5500, 6000, 50000]) {
    const after = users + userChange(rules, users, 5500);
    if (users <= 5500) assert.ok(after >= users && after <= 5500, `growth from ${users}`);
    else assert.ok(after < users && after >= 5500, `shrinkage from ${users}`);
  }
}

function programs() {
  assert.equal(researchCost(rules, "probe"), 6000);
  assert.equal(researchCost(rules, "wardens"), 6000);
  assert.equal(researchCost(rules, "seraphim"), 75000);
  assert.equal(researchCost(rules, "decommission"), 75000);
  assert.equal(researchCost(rules, "singularity"), 150000);
  assert.equal(programTier(rules, "singularity"), undefined);
  assert.equal(programCompute(rules, "eidolons"), 1200);
  assert.equal(programCompute(rules, "harvest"), 800);

  // Crash chance: a chance, never below the floor, falling with capability.
  for (const tier of [1, 2, 3] as const) {
    for (const c of CAPABILITIES) {
      const p = crashChance(rules, tier, c);
      assert.ok(p >= rules.capability.crash_min && p < 1);
    }
    assert.ok(nonincreasing(CAPABILITIES, (c) => crashChance(rules, tier, c)));
  }
  assert.equal(crashChance(rules, 1, 0), 0.15);
  assert.equal(crashChance(rules, 1, 8), rules.capability.crash_min);
  assert.equal(programCrashChance(rules, "singularity", 7), 0);

  // Deployments grow with capability.
  assert.equal(deployCount(rules, 1, 0), 40);
  assert.equal(deployCount(rules, 3, 5), 18);
  for (const tier of [1, 2, 3] as const) assert.ok(nondecreasing(CAPABILITIES, (c) => deployCount(rules, tier, c)));

  // Every share and chance a program has stays at most 1 when scaled at the
  // highest capability.
  for (const a of ARCHITECTURES) {
    for (const [id, program] of Object.entries(rules.architectures[a].programs)) {
      for (const [key, value] of Object.entries(program)) {
        if (!/_(share|chance|reduction)$/.test(key) || typeof value !== "number") continue;
        const scaled = scaledShare(rules, value, MAX_CAPABILITY);
        assert.ok(scaled >= 0 && scaled <= 1, `${id}.${key} scales to ${scaled}`);
      }
    }
  }

  // Firewalls: the starting domain's 5 on 250 sectors, and the cap.
  assert.equal(firewallBlockChance(rules, 5, 250), 0.08);
  assert.equal(firewallBlockChance(rules, 250, 250), rules.firewall.block_max);
}

function combat() {
  assert.equal(randomFactor(rules, 0), 0.85);
  assert.equal(randomFactor(rules, 0.5), 1);
  assert.ok(randomFactor(rules, 0.999999) < 1.15);
  assert.ok(Math.abs(coreBonus(rules, 10) - 1.15) < 1e-9);
  assert.equal(coreBonus(rules, 1000), 1 + rules.combat.core_bonus_max);
  assert.ok(Math.abs(opposingBonus(rules, "steward", "accelerant") - 1.1) < 1e-9);
  assert.equal(opposingBonus(rules, "steward", "symbiote"), 1);
  assert.equal(opposingBonus(rules, "steward", "steward"), 1);

  // A tie goes to the defender.
  assert.equal(battleOutcome(rules, 1000, 1000).attackerWins, false);
  assert.equal(battleOutcome(rules, 1001, 1000).attackerWins, true);

  // Whoever wins loses less, and losses are shares.
  for (const ratio of [1, 1.01, 1.2, 1.5, 2, 3, 10, 1000]) {
    for (const attackerWins of [true, false]) {
      const [a, d] = attackerWins ? [1000 * ratio + 1e-6, 1000] : [1000, 1000 * ratio];
      const o = battleOutcome(rules, a, d);
      assert.equal(o.attackerWins, attackerWins);
      const [winner, loser] = attackerWins ? [o.attackerLoss, o.defenderLoss] : [o.defenderLoss, o.attackerLoss];
      assert.ok(winner < loser, `winner loses less at ${ratio}`);
      assert.ok(winner >= 0 && loser <= rules.combat.loser_loss_max);
    }
  }
  assert.equal(battleOutcome(rules, 1000, 0).defenderLoss, rules.combat.loser_loss_max);
  assert.equal(battleOutcome(rules, 0, 0).attackerWins, false);

  // Lopsided only for a winning attacker past the ratio.
  assert.equal(battleOutcome(rules, 1500, 1000).lopsided, true);
  assert.equal(battleOutcome(rules, 1499, 1000).lopsided, false);
  assert.equal(battleOutcome(rules, 1000, 1500).lopsided, false);

  assert.equal(unitsLost(rules, 100, 0.2, false), 20);
  assert.equal(unitsLost(rules, 100, 0.2, true), 10);
  // A full conquest against an equal or stronger mind; against a weaker one,
  // (ratio)^2 of it, and a lopsided win's core only from 1/√2 of the power up.
  assert.equal(conquestScale(rules, 1000, 1000), 1);
  assert.equal(conquestScale(rules, 3000, 1000), 1);
  assert.equal(conquestScale(rules, 500, 1000), 0.25);
  assert.equal(conquestSectors(rules, 812, 1), 81);
  assert.equal(conquestSectors(rules, 812, conquestScale(rules, 500, 1000)), 20);
  assert.equal(lopsidedCores(rules, 1), 1);
  assert.equal(lopsidedCores(rules, conquestScale(rules, 710, 1000)), 1);
  assert.equal(lopsidedCores(rules, conquestScale(rules, 700, 1000)), 0);
  assert.deepEqual(raidSpoils(rules, { capital: 41200, users: 22400, buildingsExceptCores: 512 }), {
    capital: 4120,
    users: 1120,
    buildings: 10,
  });
}

function powerAndRange() {
  const s = rules.start;
  const force = forceTotals(rules, s.hardware);
  assert.deepEqual(force, { attack: 450, defense: 550, capitalUpkeep: 100, computeUpkeep: 0 });
  const built = Object.values(s.buildings).reduce((a, b) => a + b, 0);
  const start = { territory: s.territory, buildings: built, attack: force.attack, defense: force.defense, capability: 0 };
  assert.equal(power(rules, start), 3030);
  for (const key of ["territory", "buildings", "attack", "defense", "capability"] as const) {
    assert.ok(power(rules, { ...start, [key]: start[key] + 10 }) > power(rules, start), `power rises with ${key}`);
  }

  const deployments = forceTotals(rules, { grove_walkers: 10, phoenix_forms: 1 });
  assert.deepEqual(deployments, { attack: 360, defense: 390, capitalUpkeep: 0, computeUpkeep: 12.5 });

  assert.ok(inRange(rules, 1000, 1000));
  assert.ok(inRange(rules, 1000, 500) && !inRange(rules, 1000, 499));
  assert.ok(inRange(rules, 1000, 2000) && !inRange(rules, 1000, 2001));
}

function convergence() {
  assert.equal(quorum(rules, 0), 4);
  assert.equal(quorum(rules, 12), 4);
  assert.equal(quorum(rules, 13), 5);
  assert.equal(quorum(rules, 30), 7);
}

structure();
economy();
programs();
combat();
powerAndRange();
convergence();
console.log("formulas: all tests passed");
