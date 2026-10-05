import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import type { Architecture } from "../src/engine/architectures.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { describe, visibleTo, type BattleReport, type GameEvent } from "../src/engine/record.js";
import { rngFor } from "../src/engine/rng.js";
import type { Domain, World } from "../src/engine/state.js";
import { applyOrders, bootMind, createWorld } from "../src/engine/world.js";

// Minds against each other (phase 2b): attacks in both modes, battle
// programs and countermeasures, hostile programs and firewalls, Probe, the
// protection rules and deletion, against numbers worked by hand from
// config/rules.yaml. When a number in the config changes, the hand-worked
// values here may need to follow.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
/** After both boot periods. */
const T = T0 + 48 * HOUR_MS;

/**
 * HALCYON (domain 1) and VESTA (domain 2), booted at T0. Each starts with
 * 100 drones and 150 sentries: attack 450, defense 550, 10 cores. Two boot
 * events use sequence numbers 1 and 2, so HALCYON's first order is 3.
 */
function setup(
  opts: { a?: Architecture; b?: Architecture; seed?: number; change?: (a: Domain, b: Domain) => void } = {},
): World {
  let world = createWorld(rules, { epoch: 1, seed: opts.seed ?? 1, startedAt: T0 });
  for (const [designation, domainName, architecture] of [
    ["HALCYON", "Glasswater", opts.a ?? "steward"],
    ["VESTA", "Hearth", opts.b ?? "symbiote"],
  ] as const) {
    const booted = bootMind(rules, world, { designation, domainName, architecture }, T0);
    assert.ok(booted.ok);
    world = booted.world;
  }
  opts.change?.(world.domains[0]!, world.domains[1]!);
  return world;
}

/** HALCYON with 1,000 drones and nothing else: attack 3,000. */
const strong = (a: Domain) => (a.units = { drones: 1000 });

function run(world: World, orders: unknown[], now = T, who = 1) {
  const out = applyOrders(rules, world, who, orders, now);
  return { ...out, a: out.world.domains[0]!, b: out.world.domains[1]! };
}

const reportOf = (events: GameEvent[]) => events.find((e) => e.type === "battle_report") as (GameEvent & BattleReport) | undefined;
/** The first k draws of the order with this sequence number. */
const draws = (seed: number, seq: number, k: number) => {
  const rng = rngFor(seed, seq);
  return Array.from({ length: k }, () => rng.next());
};
const factor = (draw: number) => 0.85 + 0.3 * draw;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);

/** Runs a setup on seeds until `ok` holds of the outcome. */
function seedWhere(
  opts: Parameters<typeof setup>[0],
  orders: unknown[],
  ok: (out: ReturnType<typeof run> & { seed: number }) => boolean,
): ReturnType<typeof run> & { seed: number } {
  for (let seed = 1; seed < 500; seed++) {
    const out = { ...run(setup({ ...opts, seed }), orders), seed };
    if (ok(out)) return out;
  }
  throw new Error("no seed found");
}

function conquest() {
  const { a, b, results, events, world } = run(setup({ change: strong }), [{ do: "attack", target: "vesta", mode: "conquest" }]);
  const [draw] = draws(1, 3, 1);
  const report = reportOf(events)!;
  // Steward against Symbiote: neighbors, no opposing bonus.
  close(report.attackerStrength, 3000 * factor(draw!));
  // 550 defense × (1 + 10 cores × 0.015).
  close(report.defenderStrength, 550 * 1.15);
  const r = report.attackerStrength / report.defenderStrength;
  assert.ok(r >= 1.5, "lopsided");
  // Winner loses 0.12 / r²; loser min(0.35, 0.15 r).
  assert.equal(a.units.drones, 1000 - Math.floor((1000 * 0.12) / r ** 2));
  assert.deepEqual(b.units, { drones: 100 - 35, sentries: 150 - Math.floor(150 * 0.35), walkers: 0 });
  // 10% of 250 sectors; one core for the lopsided win. 7 of the 70 other
  // buildings go with the land (3 city, 1.5 datacenter, 1 factory, 1 lab,
  // 0.5 firewall, the half to the datacenters first).
  assert.equal(a.territory, 275);
  assert.equal(b.territory, 225);
  assert.deepEqual(b.buildings, { city: 27, datacenter: 13, factory: 9, lab: 9, core: 9, firewall: 5 });
  assert.equal(a.cycles, 94);
  assert.equal(results[0]!.cycles, 2);
  assert.ok(results[0]!.ok);
  assert.deepEqual(b.aggressors, [{ domain: 1, at: T }]);
  assert.deepEqual(b.hits, [T]);

  // The Record gets the line; both sides get the report.
  const line = events.find((e) => e.type === "battle")!;
  assert.equal(line.public, true);
  assert.deepEqual(line.domains, [1, 2]);
  assert.equal(describe(rules, line), "HALCYON took 25 sectors from VESTA and destroyed 1 core.");
  assert.equal(report.public, false);
  assert.ok(visibleTo(report, 2) && !visibleTo(report, 3));
  assert.ok(!("attackerStrength" in line), "the public line carries no strengths");
  assert.equal(results[0]!.message, describe(rules, report));
  assert.match(results[0]!.message, /^HALCYON took 25 sectors from VESTA and destroyed 1 core\. Strength [\d,]+ against 633\. HALCYON lost \d+ units?, VESTA 87\.$/);

  // The same seed replays the battle exactly; another seed rolls differently.
  assert.deepEqual(run(setup({ change: strong }), [{ do: "attack", target: "VESTA", mode: "conquest" }]).world, world);
  const other = run(setup({ change: strong, seed: 2 }), [{ do: "attack", target: "VESTA", mode: "conquest" }]);
  assert.notEqual(reportOf(other.events)!.attackerStrength, report.attackerStrength);
}

function raid() {
  const { a, b, events } = run(setup({ change: strong }), [{ do: "attack", target: "VESTA", mode: "raid" }]);
  // 10% of 5,000 capital, 5% of 4,000 users, 2% of 70 buildings (1, a city).
  assert.equal(b.capital, 4500);
  assert.equal(b.users, 3800);
  assert.equal(b.territory, 250);
  assert.deepEqual(b.buildings, { city: 29, datacenter: 15, factory: 10, lab: 10, core: 10, firewall: 5 });
  assert.equal(describe(rules, events.find((e) => e.type === "battle")!), "HALCYON raided VESTA: 500 capital and 200 users taken, 1 building wrecked.");
  // The 200 users fit under HALCYON's cap of 5,500 (and then grow with the
  // two cycles spent); the 500 capital is HALCYON's. Against a VESTA with no
  // capital, everything else comes out the same.
  assert.ok(a.users > 4200);
  const poor = run(setup({ change: (x, y) => (strong(x), (y.capital = 0)) }), [{ do: "attack", target: "VESTA", mode: "raid" }]);
  assert.equal(a.capital - poor.a.capital, 500);

  // A raider at its user cap gets the capital but not the users.
  const full = run(setup({ change: (x) => (strong(x), (x.users = 5500)) }), [{ do: "attack", target: "VESTA", mode: "raid" }]);
  assert.equal(full.b.users, 3800);
  assert.ok(full.a.users <= 5500);
}

function repelled() {
  // 450 attack × at most 1.15 never reaches 632.5.
  const { a, b, events, results } = run(setup(), [{ do: "attack", target: "VESTA", mode: "conquest" }]);
  assert.ok(results[0]!.ok);
  assert.equal(describe(rules, events.find((e) => e.type === "battle")!), "VESTA repelled HALCYON's attack.");
  const report = reportOf(events)!;
  const r = report.defenderStrength / report.attackerStrength;
  assert.equal(a.units.drones, 100 - Math.floor(100 * Math.min(0.35, 0.15 * r)));
  assert.equal(b.units.sentries, 150 - Math.floor((150 * 0.12) / r ** 2));
  assert.equal(a.territory, 250);
  assert.equal(b.territory, 250);
  assert.deepEqual(b.hits, [], "a repelled attack isn't a hit");
  assert.deepEqual(b.aggressors, [{ domain: 1, at: T }], "but it is aggression");

  // Opposing architectures: the attacker gets +10%.
  const opp = run(setup({ b: "accelerant" }), [{ do: "attack", target: "VESTA", mode: "raid" }]);
  close(reportOf(opp.events)!.attackerStrength, 450 * 1.1 * factor(draws(1, 3, 1)[0]!));
}

function refusals() {
  const attack = { do: "attack", target: "VESTA", mode: "conquest" };
  const refused = (world: World, order: unknown, message: string, now = T) => {
    const out = run(world, [order], now);
    assert.deepEqual(out.results[0], { do: (order as { do: string }).do, ok: false, cycles: 0, message });
    assert.deepEqual(out.b, world.domains[1], "nothing happened to VESTA");
  };
  refused(setup(), { ...attack, target: "PIKE" }, "No mind called PIKE.");
  refused(setup(), { ...attack, target: "halcyon" }, "You can't target yourself.");
  refused(setup(), { ...attack, mode: "siege" }, 'Invalid order: mode: Invalid option: expected one of "conquest"|"raid"');
  refused(setup(), attack, "You're in your boot period for another 47h.", T0 + HOUR_MS);
  refused(setup({ change: (a) => (a.bootedAt = T0 - 48 * HOUR_MS) }), attack, "VESTA is in its boot period for another 47h.", T0 + HOUR_MS);
  refused(setup({ change: (a) => (a.units = {}) }), attack, "You have no units that can attack.");
  refused(setup({ change: (a) => (a.units = { sentries: 10 }) }), { ...attack, program: "restoration" }, "You don't know Restoration.");
  refused(setup({ change: (a) => (a.known = ["hardening"]) }), { ...attack, program: "hardening" }, "Hardening isn't a battle program.");
  refused(
    setup({ change: (a) => ((a.known = ["restoration"]), (a.compute = 10)) }),
    { ...attack, program: "Restoration" },
    "Restoration needs 300 compute; you have 10.",
  );
  refused(setup({ change: (a) => ((a.cycles = 1), (a.cycleTicks = 96)) }), attack, "Out of cycles: this costs 2, 1 left.");

  // Range: half to double. Starting power is 3,030; 4,000 more sectors puts
  // VESTA at 43,030.
  const far = setup({ change: (_a, b) => (b.territory += 4000) });
  refused(far, attack, "VESTA is out of range: power 43,030, and you can reach 0.5× to 2× your 3,030.");
  // ...unless VESTA attacked HALCYON in the last 24 hours.
  const wronged = setup({ change: (a, b) => ((b.territory += 4000), (a.aggressors = [{ domain: 2, at: T - 23 * HOUR_MS }])) });
  assert.ok(run(wronged, [attack]).results[0]!.ok);
  const stale = setup({ change: (a, b) => ((b.territory += 4000), (a.aggressors = [{ domain: 2, at: T - 24 * HOUR_MS }])) });
  assert.equal(run(stale, [attack]).results[0]!.ok, false);
}

function safeMode() {
  // Three won attacks in a day shield VESTA for 12 hours.
  let world = setup({ change: strong });
  const events: GameEvent[] = [];
  for (let i = 0; i < 3; i++) {
    const out = run(world, [{ do: "attack", target: "VESTA", mode: "raid" }], T + i * HOUR_MS);
    world = out.world;
    events.push(...out.events);
  }
  const safe = events.filter((e) => e.type === "safe_mode");
  assert.equal(safe.length, 1);
  assert.equal(safe[0]!.at, T + 2 * HOUR_MS);
  assert.equal(describe(rules, safe[0]!), "VESTA dropped into safe mode.");
  const vesta = world.domains[1]!;
  assert.equal(vesta.safeModeUntil, T + 2 * HOUR_MS + 12 * HOUR_MS);
  const fourth = run(world, [{ do: "attack", target: "VESTA", mode: "raid" }], T + 3 * HOUR_MS);
  assert.equal(fourth.results[0]!.message, "VESTA is in safe mode for another 11h.");
  const later = run(world, [{ do: "attack", target: "VESTA", mode: "raid" }], T + 14 * HOUR_MS);
  assert.ok(later.results[0]!.ok);

  // Hits older than the window don't count.
  let spread = setup({ change: strong });
  for (let i = 0; i < 3; i++) spread = run(spread, [{ do: "attack", target: "VESTA", mode: "raid" }], T + i * 13 * HOUR_MS).world;
  assert.equal(spread.domains[1]!.safeModeUntil, null);

  // Attacking gives up your own safe mode.
  const shielded = setup({ change: (a) => (strong(a), (a.safeModeUntil = T + 6 * HOUR_MS)) });
  assert.equal(run(shielded, [{ do: "attack", target: "VESTA", mode: "raid" }]).a.safeModeUntil, null);
}

function battlePrograms() {
  const attack = (program?: string, mode = "conquest") => [{ do: "attack", target: "VESTA", mode, ...(program ? { program } : {}) }];
  const ran = (out: ReturnType<typeof run>) => reportOf(out.events)!.attackerProgram?.outcome === "ran";

  // Arc Strike: +15% × (1 + 0.1 × capability 1). Draws: crash, then factor.
  const arc = seedWhere({ a: "accelerant", change: (a) => (strong(a), (a.known = ["arc_strike"])) }, attack("Arc Strike"), ran);
  const [, arcDraw] = draws(arc.seed, 3, 2);
  close(reportOf(arc.events)!.attackerStrength, 3000 * 1.165 * factor(arcDraw!));
  assert.equal(arc.a.compute, 1000 - 300 + 2 * 90);
  // Crash: 0.25 - 0.03 × 1. A crashed program spends its compute; the attack goes on.
  const crashed = seedWhere(
    { a: "accelerant", change: (a) => (strong(a), (a.known = ["arc_strike"])) },
    attack("arc_strike"),
    (o) => reportOf(o.events)!.attackerProgram?.outcome === "crashed",
  );
  assert.ok(draws(crashed.seed, 3, 1)[0]! < 0.22);
  close(reportOf(crashed.events)!.attackerStrength, 3000 * factor(draws(crashed.seed, 3, 2)[1]!));
  assert.match(crashed.results[0]!.message, /HALCYON's Arc Strike crashed\./);

  // Entanglement on attack: the defender's strength × (1 - 0.15 × 1.1).
  const ent = seedWhere({ a: "symbiote", b: "steward", change: (a) => (strong(a), (a.known = ["entanglement"])) }, attack("entanglement"), ran);
  close(reportOf(ent.events)!.defenderStrength, 550 * 1.15 * (1 - 0.165));

  // Restoration: the caster's losses × (1 - 0.4 × 1.1).
  const res = seedWhere({ change: (a) => (strong(a), (a.known = ["restoration"])) }, attack("restoration"), ran);
  const resReport = reportOf(res.events)!;
  const r = resReport.attackerStrength / resReport.defenderStrength;
  assert.equal(res.a.units.drones, 1000 - Math.floor(1000 * (0.12 / r ** 2) * (1 - 0.44)));

  // Recycle Casualties: 25% × 1.1 of the lost units' attack plus defense
  // (4 per drone) comes back as Husks (8 each).
  const rec = seedWhere(
    { a: "assimilator", change: (a) => ((a.units = { drones: 100 }), (a.known = ["recycle_casualties"])) },
    attack("recycle casualties"),
    ran,
  );
  const lost = 100 - rec.a.units.drones!;
  assert.ok(lost > 0);
  assert.equal(rec.a.units.husks, Math.floor((lost * 4 * 0.275) / 8));
  assert.equal(reportOf(rec.events)!.attackerRecycled, rec.a.units.husks);

  // Adversarial Input on attack: with 20% × 1.1, the defender's strength
  // halves. Draws: crash, factor, miss.
  const adv = seedWhere(
    { a: "oracle", change: (a) => (strong(a), (a.known = ["adversarial_input"])) },
    attack("adversarial_input"),
    (o) => ran(o) && draws(o.seed, 3, 3)[2]! < 0.22,
  );
  close(reportOf(adv.events)!.defenderStrength, 550 * 1.15 * 0.5);

  // Self programs: Overclock (attack +22%) and Hardening (defense +22%).
  const over = run(setup({ a: "accelerant", change: (a) => (strong(a), (a.known = ["overclock"]), (a.running = [{ program: "overclock", cyclesLeft: 5 }])) }), attack());
  close(reportOf(over.events)!.attackerStrength, 3000 * 1.22 * factor(draws(1, 3, 1)[0]!));
  const hard = run(setup({ b: "steward", change: (a, b) => (strong(a), (b.known = ["hardening"]), (b.running = [{ program: "hardening", endsAt: T + HOUR_MS }])) }), attack());
  close(reportOf(hard.events)!.defenderStrength, 550 * 1.15 * 1.22);

  // False Signature: decoys take 20% × 1.1 of the defender's losses.
  const decoy = run(setup({ b: "oracle", change: (a, b) => (strong(a), (b.known = ["false_signature"]), (b.running = [{ program: "false_signature", endsAt: T + HOUR_MS }])) }), attack());
  assert.equal(decoy.b.units.sentries, 150 - Math.floor(150 * 0.35 * (1 - 0.22)));
}

function countermeasures() {
  const attack = [{ do: "attack", target: "VESTA", mode: "conquest" }];
  const cm = (program: string, above: number, compute = 1000) => (a: Domain, b: Domain) => {
    strong(a);
    b.known = [program as never];
    b.countermeasure = { program: program as never, above };
    b.compute = compute;
  };
  const fired = (o: ReturnType<typeof run>) => reportOf(o.events)!.countermeasure?.outcome === "ran";

  // Setting one is free; it must be a known battle program.
  const set = run(setup({ change: (a) => (a.known = ["restoration", "hardening"]) }), [
    { do: "set_countermeasure", program: "Restoration", above: 0.6 },
    { do: "set_countermeasure", program: "Hardening", above: 0.6 },
    { do: "set_countermeasure", program: "Entanglement", above: 0.6 },
    { do: "set_countermeasure", program: "Restoration" },
  ]);
  assert.deepEqual(
    set.results.map((r) => r.message),
    [
      "Countermeasure: Restoration when an attacker's attack exceeds 60% of your defense.",
      "Hardening isn't a battle program.",
      "You don't know Entanglement.",
      "Invalid order: give above with a program",
    ],
  );
  assert.deepEqual(set.a.countermeasure, { program: "restoration", above: 0.6 });
  assert.equal(set.a.cycles, 96);
  assert.equal(run(set.world, [{ do: "set_countermeasure", program: null }]).a.countermeasure, null);

  // Entanglement fires (3,000 > 0.5 × 550): the attacker's strength × 0.835.
  // Draws: the countermeasure's crash, then the factor.
  const ent = seedWhere({ change: cm("entanglement", 0.5) }, attack, fired);
  close(reportOf(ent.events)!.attackerStrength, 3000 * 0.835 * factor(draws(ent.seed, 3, 2)[1]!));
  assert.equal(ent.b.compute, 700, "its compute is spent");
  assert.match(ent.results[0]!.message, /VESTA's countermeasure Entanglement ran\./);

  // Under the threshold it doesn't fire (3,000 < 6 × 550 isn't possible: above caps at 2).
  const quiet = run(setup({ change: (a, b) => ((a.units = { drones: 100 }), cm("entanglement", 2)(a, b), (a.units = { drones: 100 })) }), attack);
  assert.equal(reportOf(quiet.events)!.countermeasure, null);
  assert.equal(quiet.b.compute, 1000);

  // Without the compute it can't fire.
  const broke = run(setup({ change: cm("entanglement", 0.5, 100) }), attack);
  assert.deepEqual(reportOf(broke.events)!.countermeasure, { program: "entanglement", outcome: "no_compute" });
  assert.equal(broke.b.compute, 100);

  // Arc Strike as a countermeasure raises the defender's strength.
  const arc = seedWhere({ b: "accelerant", change: cm("arc_strike", 0.5) }, attack, fired);
  close(reportOf(arc.events)!.defenderStrength, 550 * 1.15 * 1.165);
}

function hostilePrograms() {
  /** HALCYON knows the program; VESTA has no firewalls; it neither crashes nor gets blocked. */
  const landed = (a: Architecture, program: string, change?: (a: Domain, b: Domain) => void) =>
    seedWhere(
      { a, change: (x, y) => ((x.known = [program as never]), (y.buildings.firewall = 0), change?.(x, y)) },
      [{ do: "execute", program, target: "VESTA" }],
      (o) => o.results[0]!.ok,
    );
  // Tier 3, capability 1: crash chance 0.32; shares × 1.1.

  const dec = landed("steward", "decommission", (_a, b) => (b.units = { spore_drones: 100, grove_walkers: 10, drones: 50 }));
  assert.deepEqual(dec.b.units, { spore_drones: 92, grove_walkers: 10, drones: 50 });
  assert.equal(dec.results[0]!.message, "HALCYON ran Decommission on VESTA: 8 deployments destroyed.");
  assert.equal(dec.a.cycles, 95);
  assert.ok(dec.events.find((e) => e.type === "hostile")!.public, "an act of war is public");

  const blight = landed("symbiote", "blight");
  assert.equal(blight.b.capital, 5000 - Math.floor(5000 * 0.088));
  assert.equal(blight.b.growthStalledUntil, T + 12 * HOUR_MS);
  assert.equal(blight.results[0]!.message, `HALCYON ran Blight on VESTA: ${Math.floor(5000 * 0.088)} capital destroyed, user growth stalled for 12 hours.`);
  // VESTA (4,000 users, cap 5,500) doesn't grow while it lasts, and does after.
  assert.equal(run(blight.world, [{ do: "monetize" }], T + HOUR_MS, 2).b.users, 4000);
  assert.ok(run(blight.world, [{ do: "monetize" }], T + 12 * HOUR_MS, 2).b.users > 4000);

  // Kinetic Cascade: 2% × 1.1 of the 65 non-core buildings: 1, a city.
  const kc = landed("accelerant", "kinetic_cascade");
  assert.deepEqual(kc.b.buildings, { city: 29, datacenter: 15, factory: 10, lab: 10, core: 10, firewall: 0 });

  const harvest = landed("assimilator", "harvest");
  assert.equal(harvest.b.users, 4000 - Math.floor(4000 * 0.066));

  // Exfiltration: 10% × 1.1 of VESTA's compute and 3 of its stored cycles.
  // HALCYON's compute: 1,000 - 900 + 110 stolen + 90 income.
  const exf = landed("oracle", "exfiltration", (a) => ((a.cycles = 90), (a.cycleTicks = 96)));
  assert.equal(exf.b.compute, 890);
  assert.equal(exf.b.cycles, 93);
  assert.equal(exf.a.compute, 300);
  assert.equal(exf.a.cycles, 92);
  assert.equal(exf.results[0]!.message, "HALCYON ran Exfiltration on VESTA: 110 compute stolen, 3 cycles stolen.");
  assert.deepEqual(exf.b.aggressors, [{ domain: 1, at: T }]);

  // Firewalls: 100 of 250 sectors reaches the 60% cap. A block still spends
  // and still counts as aggression and toward the cap.
  const blocked = seedWhere(
    { a: "symbiote", change: (a, b) => ((a.known = ["blight"]), (b.buildings.firewall = 100)) },
    [{ do: "execute", program: "blight", target: "VESTA" }],
    (o) => o.events.some((e) => e.type === "hostile"),
  );
  const [crash, block] = draws(blocked.seed, 3, 2);
  assert.ok(crash! >= 0.32);
  const wasBlocked = block! < 0.6;
  assert.equal(blocked.results[0]!.ok, !wasBlocked);
  if (wasBlocked) {
    assert.equal(blocked.results[0]!.message, "VESTA's firewalls blocked HALCYON's Blight.");
    assert.equal(blocked.b.capital, 5000);
  }
  assert.deepEqual(blocked.b.hostileReceived, [T]);

  // A crash spends compute and the cycle but never reaches the target.
  const crashed = seedWhere(
    { a: "symbiote", change: (a) => (a.known = ["blight"]) },
    [{ do: "execute", program: "blight", target: "VESTA" }],
    (o) => /crashed/.test(o.results[0]!.message),
  );
  assert.deepEqual(crashed.b.hostileReceived, []);
  assert.equal(crashed.a.cycles, 95);
  assert.deepEqual(crashed.events.filter((e) => e.type === "hostile"), []);

  // Six a day per target, from everyone together.
  const capped = setup({ a: "symbiote", change: (a, b) => ((a.known = ["blight"]), (b.hostileReceived = Array(6).fill(T - HOUR_MS))) });
  assert.equal(run(capped, [{ do: "execute", program: "blight", target: "VESTA" }]).results[0]!.message, "VESTA has taken all the hostile programs it can today.");
  assert.ok(/crashed|Blight/.test(run(capped, [{ do: "execute", program: "blight", target: "VESTA" }], T + 23 * HOUR_MS).results[0]!.message));

  // Hostile programs pass the same protection as attacks; they need a target.
  const early = run(setup({ a: "symbiote", change: (a) => (a.known = ["blight"]) }), [{ do: "execute", program: "blight", target: "VESTA" }], T0);
  assert.equal(early.results[0]!.message, "You're in your boot period for another 48h.");
  const untargeted = run(setup({ a: "symbiote", change: (a) => (a.known = ["blight"]) }), [{ do: "execute", program: "blight" }]);
  assert.equal(untargeted.results[0]!.message, "Blight needs a target.");
  const selfTargeted = run(setup({ change: (a) => (a.known = ["hardening"]) }), [{ do: "execute", program: "hardening", target: "VESTA" }]);
  assert.equal(selfTargeted.results[0]!.message, "Hardening doesn't take a target.");
}

function probe() {
  // Probe ignores protection: it works in the boot period, unseen by the target.
  const out = seedWhere(
    { change: (a, b) => ((a.known = ["probe"]), (b.scratchpad = "secret")) },
    [{ do: "execute", program: "Probe", target: "VESTA" }],
    (o) => o.results[0]!.ok,
  );
  const status = out.results[0]!.status!;
  assert.equal(status.designation, "VESTA");
  assert.equal(status.power, 3030);
  assert.equal(status.cycles, 96);
  assert.equal(status.compute, 1000);
  assert.ok(!("scratchpad" in status));
  assert.equal(out.results[0]!.message, "Probed VESTA: power 3,030, 96 cycles, capability 0.");
  assert.equal(out.a.compute, 1000 - 150 + 90);
  const probed = out.events.find((e) => e.type === "probed")!;
  assert.equal(probed.public, false);
  assert.ok(visibleTo(probed, 1) && !visibleTo(probed, 2));
  assert.deepEqual(out.b.aggressors, []);

  const boot = run(setup({ seed: out.seed, change: (a) => (a.known = ["probe"]) }), [{ do: "execute", program: "probe", target: "VESTA" }], T0);
  assert.ok(boot.results[0]!.ok);
}

function deletion() {
  // VESTA down to one core loses it to a lopsided conquest.
  const out = run(setup({ change: (a, b) => (strong(a), (b.buildings.core = 1)) }), [{ do: "attack", target: "VESTA", mode: "conquest" }]);
  assert.equal(out.b.buildings.core, 0);
  assert.equal(out.b.deletedAt, T);
  const deleted = out.events.find((e) => e.type === "deleted")!;
  assert.equal(deleted.public, true);
  assert.equal(describe(rules, deleted), "VESTA of Hearth was deleted by HALCYON.");

  // It can't act or be targeted, and its name is taken until the reboot wait passes.
  const acts = applyOrders(rules, out.world, 2, [{ do: "monetize" }, "junk"], T + HOUR_MS);
  assert.deepEqual(acts.results.map((r) => r.message), ["This mind has been deleted.", "This mind has been deleted."]);
  assert.deepEqual(acts.world.domains[1], { ...out.world.domains[1]! });
  assert.equal(run(out.world, [{ do: "attack", target: "VESTA", mode: "raid" }], T + HOUR_MS).results[0]!.message, "No mind called VESTA.");
  const boot = (now: number) => bootMind(rules, out.world, { designation: "VESTA", domainName: "Hearth II", architecture: "oracle" }, now);
  assert.deepEqual(boot(T + 23 * HOUR_MS), { ok: false, error: "VESTA is taken." });
  const reborn = boot(T + 24 * HOUR_MS);
  assert.ok(reborn.ok);
  assert.equal(reborn.domain, 3);
}

conquest();
raid();
repelled();
refusals();
safeMode();
battlePrograms();
countermeasures();
hostilePrograms();
probe();
deletion();
console.log("conflict: all tests passed");
