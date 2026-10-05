import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import type { Architecture, Program } from "../src/engine/architectures.js";
import { availableCycles, HOUR_MS, MINUTE_MS, wastedCycles } from "../src/engine/cycles.js";
import { capability, domainPower, totalBuildings } from "../src/engine/domain.js";
import { deployCount, programCrashChance } from "../src/engine/programs.js";
import { describe, type GameEvent } from "../src/engine/record.js";
import type { Domain, World } from "../src/engine/state.js";
import { applyOrders, bootMind, createWorld, settle } from "../src/engine/world.js";

// One domain on its own (phase 2a): booting, cycles, the per-cycle economy,
// each order against numbers worked by hand from config/rules.yaml, and
// timers. When a number in the config changes, the hand-worked values here
// may need to follow.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);

/** A world with one freshly booted mind, and a way to change its domain before a test. */
function setup(architecture: Architecture = "steward", change?: (d: Domain) => void, seed = 1): World {
  const booted = bootMind(rules, createWorld(rules, { epoch: 1, seed, startedAt: T0 }), { designation: "HALCYON", domainName: "Glasswater", architecture }, T0);
  assert.ok(booted.ok);
  change?.(booted.world.domains[0]!);
  return booted.world;
}

const domainOf = (w: World) => w.domains[0]!;

function run(world: World, orders: unknown[], now = T0) {
  const out = applyOrders(rules, world, 1, orders, now);
  return { ...out, d: domainOf(out.world) };
}

function boot() {
  const world = setup();
  const d = domainOf(world);
  assert.equal(d.territory, 250);
  assert.equal(totalBuildings(d), 80);
  assert.equal(d.cycles, 96);
  assert.equal(capability(d), 0);
  assert.equal(domainPower(rules, d), 3150);

  const fresh = createWorld(rules, { epoch: 1, seed: 1, startedAt: T0 });
  const ok = (input: object) => bootMind(rules, fresh, { designation: "A", domainName: "B", architecture: "oracle", ...input }, T0);
  assert.ok(ok({}).ok);
  assert.ok(ok({ designation: "Pale Choir-7" }).ok);
  assert.equal(ok({ designation: "" }).ok, false);
  assert.equal(ok({ designation: " -x" }).ok, false);
  assert.equal(ok({ designation: "X".repeat(41) }).ok, false);
  assert.equal(ok({ domainName: "" }).ok, false);
  assert.equal(ok({ domainName: "a\u0007b" }).ok, false);
  assert.equal(ok({ manifesto: "M".repeat(601) }).ok, false);
  assert.equal(ok({ architecture: "druid" }).ok, false);
  const second = bootMind(rules, world, { designation: "halcyon", domainName: "Elsewhere", architecture: "oracle" }, T0);
  assert.deepEqual(second, { ok: false, error: "halcyon is taken." });

  // The boot is public.
  const booted = bootMind(rules, fresh, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0);
  assert.ok(booted.ok);
  assert.equal(booted.events.length, 1);
  assert.equal(booted.events[0]!.public, true);
  assert.equal(describe(rules, booted.events[0]!), "VESTA of Hearth came online: a Steward mind.");
}

function cycles() {
  const world = setup();
  const d = domainOf(world);
  // Full at boot, so the first cycle accrued is lost to the cap.
  assert.equal(availableCycles(rules, d, T0 + 29 * MINUTE_MS), 96);
  assert.equal(wastedCycles(rules, d, T0 + 30 * MINUTE_MS), 1);

  // Spend 10 at 0:30, then 0:30 and 1:30 later two more have accrued.
  const after = run(world, [{ do: "monetize", cycles: 10 }], T0 + 30 * MINUTE_MS).d;
  assert.equal(after.cycles, 86);
  assert.equal(after.cyclesWasted, 1);
  assert.equal(availableCycles(rules, after, T0 + 89 * MINUTE_MS), 87);
  assert.equal(availableCycles(rules, after, T0 + 90 * MINUTE_MS), 88);
  // Two days on, it's back at the cap and counting losses again.
  assert.equal(availableCycles(rules, after, T0 + 48 * HOUR_MS), 96);
  assert.equal(wastedCycles(rules, after, T0 + 48 * HOUR_MS), 1 + 95 - 10);
}

function economy() {
  // Expand once: 10 sectors, then the cycle's economy. Income 4,000 × 0.06 +
  // 30 × 2 = 300; upkeep 60 for buildings + 250 × 0.4 for hardware = 160;
  // users close 4% of the gap to the new cap (30 × 100 + 260 × 10 = 5,600).
  const { d, results } = run(setup(), [{ do: "expand" }]);
  assert.deepEqual(results, [{ do: "expand", ok: true, cycles: 1, message: "Expanded: +10 sectors, territory 260." }]);
  assert.equal(d.territory, 260);
  assert.equal(d.capital, 5000 + 300 - 160);
  assert.equal(d.users, 4000 + 64);
  assert.equal(d.compute, 1000 + 90);
  assert.equal(d.cycles, 95);

  // Monetize adds a cycle's income on top of the cycle's own.
  assert.equal(run(setup(), [{ do: "monetize" }]).d.capital, 5000 + 300 + 300 - 160);
  // Spin Up likewise for compute, within storage (1,000 + 15 × 80 = 2,200).
  assert.equal(run(setup(), [{ do: "spin_up" }]).d.compute, 1000 + 90 + 90);
  assert.equal(run(setup("steward", (d) => (d.compute = 2150)), [{ do: "spin_up" }]).d.compute, 2200);

  // Unpaid upkeep: with 1,000 drones, upkeep is 60 + 1,150 × 0.4 = 520, more
  // than a cycle's 300 income covers from nothing, so a tenth of each
  // hardware type is abandoned.
  const broke = run(
    setup("steward", (d) => {
      d.capital = 0;
      d.units.drones = 1000;
    }),
    [{ do: "expand" }],
  );
  assert.equal(broke.d.capital, 0);
  assert.equal(broke.d.units.drones, 900);
  assert.equal(broke.d.units.sentries, 135);
  assert.equal(broke.events.length, 1);
  assert.equal(describe(rules, broke.events[0]!), "Upkeep went unpaid: 115 hardware abandoned.");
  assert.equal(broke.events[0]!.public, false);

  // Compute short for deployments: 1,000 Wardens cost 200 a cycle against 90
  // income from nothing, so a tenth shut down; hardware is untouched.
  const dark = run(
    setup("steward", (d) => {
      d.compute = 0;
      d.units.wardens = 1000;
    }),
    [{ do: "expand" }],
  );
  assert.equal(dark.d.compute, 0);
  assert.equal(dark.d.units.wardens, 900);
  assert.equal(dark.d.units.drones, 100);
  assert.equal(describe(rules, dark.events[0]!), "Upkeep went unpaid: 100 deployments shut down.");
}

function building() {
  // 12 cities at a build rate of 10: two batches, two cycles, 240 capital each.
  const { d, results } = run(setup(), [{ do: "build", building: "City", count: 12 }]);
  assert.equal(results[0]!.message, "Built City ×12.");
  assert.equal(results[0]!.cycles, 2);
  assert.equal(d.buildings.city, 42);
  // Batch 1: -2,400, then income 4,000 × 0.06 + 40 × 2 = 320, upkeep 160;
  // users grow (6,500 − 4,000) × 4% = 100. Batch 2: -480, income 4,100 ×
  // 0.06 + 42 × 2 = 330, upkeep 160.
  assert.equal(d.capital, 5000 - 2400 + 320 - 160 - 480 + 330 - 160);

  // Several kinds share a batch.
  const mixed = run(setup(), [{ do: "build", buildings: { lab: 4, datacenter: 6 } }]);
  assert.equal(mixed.results[0]!.cycles, 1);
  assert.equal(mixed.d.buildings.lab, 14);
  assert.equal(mixed.d.buildings.datacenter, 21);

  // Capital runs out partway: the order says how far it got and why.
  const short = run(setup("steward", (d) => (d.capital = 1000)), [{ do: "build", building: "lab", count: 10 }]);
  assert.equal(short.d.buildings.lab, 12); // 360 each at 250 sectors
  assert.match(short.results[0]!.message, /Stopped at 2 of 10: not enough capital/);
  // No open land: nothing built, no cycle spent.
  const full = run(setup("steward", (d) => (d.territory = 80)), [{ do: "build", building: "lab", count: 1 }]);
  assert.deepEqual(full.results[0], { do: "build", ok: false, cycles: 0, message: "Built nothing: no open land." });
  assert.equal(full.d.cycles, 96);

  assert.equal(run(setup(), [{ do: "build", building: "castle", count: 1 }]).results[0]!.message, "No such building: castle.");
}

function manufacturing() {
  // 20 per batch from 10 factories; 40 capital and one user each.
  const { d, results } = run(setup(), [{ do: "manufacture", unit: "drones", count: 30 }]);
  assert.equal(results[0]!.cycles, 2);
  assert.equal(d.units.drones, 130);

  // Housing: 500 from 10 factories, 250 already used.
  const housed = run(setup("steward", (d) => (d.capital = 100_000)), [{ do: "manufacture", units: { walkers: 300 } }, { do: "manufacture", unit: "drones", count: 1 }]);
  assert.equal(housed.d.units.walkers, 250);
  assert.match(housed.results[0]!.message, /no factory housing left/);
  assert.equal(housed.results[1]!.message, "Manufactured nothing: no factory housing left.");

  assert.match(run(setup(), [{ do: "manufacture", unit: "wardens", count: 1 }]).results[0]!.message, /deployed by running their program/);
}

function research() {
  const steward = setup("steward", (d) => (d.researchProgress.probe = 5995));
  const set = run(steward, [{ do: "set_research", program: "Probe" }, { do: "expand" }]);
  assert.equal(set.results[0]!.message, "Researching Probe: 5,995 of 6,000 points.");
  assert.equal(set.results[0]!.cycles, 0);
  assert.deepEqual(set.d.known, ["probe"]);
  assert.equal(set.d.researchTarget, null);
  assert.equal(set.d.researchProgress.probe, undefined);
  assert.equal(describe(rules, set.events.find((e) => e.type === "learned")!), "Research complete: Probe.");

  // Progress is kept per program when the target changes.
  const switched = run(setup(), [{ do: "set_research", program: "wardens" }, { do: "expand", cycles: 3 }, { do: "set_research", program: "hardening" }, { do: "expand" }]);
  assert.equal(switched.d.researchProgress.wardens, 30);
  assert.equal(switched.d.researchProgress.hardening, 10);

  // Only this architecture's programs, not ones already known, and the
  // Singularity only after the other seven.
  const refuse = (orders: unknown[], change?: (d: Domain) => void) => run(setup("steward", change), orders).results.map((r) => r.ok);
  assert.deepEqual(refuse([{ do: "set_research", program: "Blight" }]), [false]);
  assert.deepEqual(refuse([{ do: "set_research", program: "nonsense" }]), [false]);
  assert.deepEqual(refuse([{ do: "set_research", program: "probe" }], (d) => (d.known = ["probe"])), [false]);
  assert.deepEqual(refuse([{ do: "set_research", program: "singularity" }]), [false]);
  const seven: Program[] = ["probe", "wardens", "sentinels", "seraphim", "hardening", "restoration", "decommission"];
  assert.deepEqual(refuse([{ do: "set_research", program: "The Singularity" }], (d) => (d.known = [...seven])), [true]);
}

function programs() {
  // A deployment: compute paid, a cycle spent, and the units arrive unless it crashes.
  let crashes = 0;
  let deployed = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const world = setup("steward", (d) => (d.known = ["probe", "wardens"]), seed);
    const { d, results } = run(world, [{ do: "execute", program: "Wardens" }]);
    assert.equal(d.cycles, 95);
    if (results[0]!.ok) {
      deployed++;
      assert.equal(d.units.wardens, deployCount(rules, 1, 2));
      // 48 Wardens at 0.2 upkeep cost 10 compute this cycle.
      assert.equal(d.compute, 1000 - 500 + 90 - 10);
    } else {
      crashes++;
      assert.equal(d.units.wardens, undefined);
      assert.equal(d.compute, 1000 - 500 + 90);
      assert.match(results[0]!.message, /crashed/);
    }
    // The same seed and orders give the same outcome.
    assert.deepEqual(run(world, [{ do: "execute", program: "Wardens" }]).d, d);
  }
  // About the crash chance: 15% − 2 × 3% = 9% at capability 2.
  const chance = programCrashChance(rules, "wardens", 2);
  assert.ok(Math.abs(crashes / 200 - chance) < 0.06, `${crashes} crashes in 200 at ${chance}`);
  assert.equal(crashes + deployed, 200);

  const refused = run(setup("steward", (d) => (d.known = ["wardens"])), [
    { do: "execute", program: "hardening" },
    { do: "execute", program: "sentinels" },
  ]);
  assert.deepEqual(refused.results.map((r) => r.message), ["You don't know Hardening.", "You don't know Sentinels."]);
  const poor = run(setup("steward", (d) => ((d.known = ["sentinels"]), (d.compute = 100))), [{ do: "execute", program: "sentinels" }]);
  assert.equal(poor.results[0]!.message, "Sentinels needs 1,200 compute; you have 100.");
  assert.equal(poor.d.cycles, 96);
}

/** The world's program timers, leaving out the Shutdown's. */
const programTimers = (w: World) => w.timers.filter((t) => t.kind === "program_ends");

/** Runs orders on seeds until one doesn't crash. */
function runUncrashed(architecture: Architecture, change: (d: Domain) => void, orders: unknown[]) {
  for (let seed = 1; ; seed++) {
    const out = run(setup(architecture, change, seed), orders);
    if (out.results.every((r) => r.ok)) return out;
  }
}

function selfPrograms() {
  // Hardening counts hours: a timer ends it, and settling again changes nothing.
  const hard = runUncrashed("steward", (d) => (d.known = ["hardening"]), [{ do: "execute", program: "hardening" }]);
  assert.equal(hard.results[0]!.message, "Hardening running for 12 hours.");
  assert.deepEqual(hard.d.running, [{ program: "hardening", endsAt: T0 + 12 * HOUR_MS }]);
  assert.equal(programTimers(hard.world).length, 1);
  const early = settle(rules, hard.world, T0 + 12 * HOUR_MS - 1);
  assert.deepEqual(early.events, []);
  const ended = settle(rules, early.world, T0 + 12 * HOUR_MS);
  assert.deepEqual(domainOf(ended.world).running, []);
  assert.deepEqual(programTimers(ended.world), []);
  assert.deepEqual(ended.events.map((e) => describe(rules, e)), ["Hardening ended."]);
  const again = settle(rules, ended.world, T0 + 12 * HOUR_MS);
  assert.deepEqual(again.events, []);
  assert.deepEqual(again.world, ended.world);
  assert.throws(() => settle(rules, ended.world, T0), /already at/);

  // Running it again before it ends restarts it, with one timer.
  const twice = runUncrashed("steward", (d) => (d.known = ["hardening"]), [{ do: "execute", program: "hardening" }]);
  const rerun = applyOrders(rules, twice.world, 1, [{ do: "execute", program: "hardening" }], T0 + 6 * HOUR_MS);
  if (rerun.results[0]!.ok) {
    assert.equal(programTimers(rerun.world).length, 1);
    assert.deepEqual(domainOf(settle(rules, rerun.world, T0 + 12 * HOUR_MS).world).running.length, 1);
  }

  // Abundance Protocol counts the caster's cycles: 24, this one included.
  // Capital +15% × (1 + 0.1 × capability 1), user growth +50% × 1.1.
  const abundant = runUncrashed("symbiote", (d) => (d.known = ["abundance_protocol"]), [{ do: "execute", program: "Abundance Protocol" }]);
  assert.deepEqual(abundant.d.running, [{ program: "abundance_protocol", cyclesLeft: 23 }]);
  assert.equal(abundant.d.capital, 5000 + Math.floor(300 * (1 + 0.15 * 1.1)) - 160);
  assert.equal(abundant.d.users, 4000 + Math.floor(1500 * 0.04 * (1 + 0.5 * 1.1)));
  const later = applyOrders(rules, abundant.world, 1, [{ do: "monetize", cycles: 23 }, { do: "monetize" }], T0);
  assert.deepEqual(domainOf(later.world).running, []);
  assert.deepEqual(later.events.map((e) => describe(rules, e)), ["Abundance Protocol ended."]);

  // Assimilation converts 5% × 1.1 of users into 1.5 compute each, now.
  const assimilated = runUncrashed("assimilator", (d) => (d.known = ["assimilation"]), [{ do: "execute", program: "assimilation" }]);
  const converted = Math.floor(4000 * 0.05 * 1.1);
  assert.equal(assimilated.results[0]!.message, `Assimilation: ${converted} users converted into ${converted * 1.5} compute.`);
  assert.equal(assimilated.d.compute, 1000 + converted * 1.5 + 90);

  // Battle programs run only with an attack or as a countermeasure.
  const battle = run(setup("steward", (d) => (d.known = ["restoration"])), [{ do: "execute", program: "restoration" }]);
  assert.equal(battle.results[0]!.message, "Restoration runs with an attack or as a countermeasure, not on its own.");
  assert.equal(battle.d.cycles, 96);
}

function ordersRun() {
  // When cycles run out, cycle-costing orders are skipped; free ones still run.
  const world = run(setup(), [{ do: "monetize", cycles: 95 }]).world;
  const { d, results } = run(world, [
    { do: "expand", cycles: 3 },
    { do: "monetize" },
    { do: "scratchpad", text: "VESTA is reliable." },
  ]);
  assert.deepEqual(results.map((r) => [r.ok, r.cycles]), [[true, 1], [false, 0], [true, 0]]);
  assert.match(results[0]!.message, /Stopped after 1 of 3 cycles: out of cycles\./);
  assert.equal(results[1]!.message, "Out of cycles: this costs 1, 0 left.");
  assert.equal(d.scratchpad, "VESTA is reliable.");
  assert.equal(d.cycles, 0);

  // Malformed orders fail alone and don't use a sequence number.
  const bad = run(setup(), [
    { do: "fly" },
    5,
    { do: "expand", cycles: -1 },
    { do: "build", building: "city" },
    { do: "build", building: "city", count: 1, buildings: { lab: 1 } },
    { do: "scratchpad", text: "x".repeat(1001) },
    { do: "expand" },
  ]);
  assert.deepEqual(bad.results.map((r) => r.ok), [false, false, false, false, false, false, true]);
  assert.deepEqual(bad.results.slice(0, 2).map((r) => r.do), ["fly", "?"]);
  assert.ok(bad.results.every((r) => r.message.length > 0));
  assert.equal(bad.world.seq, setup().seq + 2);
  assert.throws(() => applyOrders(rules, setup(), 1, { do: "expand" }, T0), /must be a list/);
  assert.throws(() => applyOrders(rules, setup(), 99, [], T0), /no domain/);

  // Submitting orders marks the mind active.
  assert.equal(run(setup(), [], T0 + HOUR_MS).d.lastActiveAt, T0 + HOUR_MS);
}

function events() {
  // Every event has a fresh sequence number, a time, and a line of text.
  const out = run(setup("steward", (d) => ((d.researchProgress.probe = 5995), (d.capital = 0), (d.units.drones = 1000))), [
    { do: "set_research", program: "probe" },
    { do: "expand" },
  ]);
  const seqs = out.events.map((e: GameEvent) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  for (const e of out.events) {
    assert.equal(e.at, T0);
    assert.ok(describe(rules, e).length > 0);
    assert.deepEqual(e.domains, [1]);
  }
}

boot();
cycles();
economy();
building();
manufacturing();
research();
programs();
selfPrograms();
ordersRun();
events();
console.log("domain: all tests passed");
