import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { programsOf } from "../src/engine/architectures.js";
import { quorum } from "../src/engine/convergence.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { describe, type GameEvent } from "../src/engine/record.js";
import type { Domain, World } from "../src/engine/state.js";
import { applyOrders, bootMind, createWorld, settle } from "../src/engine/world.js";

// The Singularity and the Shutdown (phase 2b): converging one mind at a
// time, the join gap, collapse by timeout, by a lost conquest and by
// deletion, reaching the quorum, and day 60.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const T = T0 + 48 * HOUR_MS;
const NAMES = ["HALCYON", "VESTA", "PIKE", "SABER", "OUROBOROS"];
const singularity = { do: "execute", program: "The Singularity" };

/** Five Steward minds, each knowing all eight programs, with the compute storage and compute to run the Singularity. */
function setup(change?: (ds: Domain[]) => void): World {
  let world = createWorld(rules, { epoch: 1, seed: 7, startedAt: T0 });
  for (const designation of NAMES) {
    const booted = bootMind(rules, world, { designation, domainName: "Test", architecture: "steward" }, T0);
    assert.ok(booted.ok);
    world = booted.world;
  }
  for (const d of world.domains) {
    d.known = programsOf("steward").map((p) => p.id);
    d.buildings.datacenter = 200;
    d.compute = 16000;
  }
  change?.(world.domains);
  return world;
}

function run(world: World, who: number, orders: unknown[], now: number) {
  const out = applyOrders(rules, world, who, orders, now);
  return { ...out, d: out.world.domains[who - 1]! };
}

const lines = (events: GameEvent[]) => events.map((e) => describe(rules, e));
/** Makes every mind active again, as if each had just woken. */
const wakeAll = (world: World, now: number) => world.domains.reduce((w, d) => run(w, d.id, [], now).world, world);

function quorumRule() {
  // Active domains / 3, rounded up, between 4 and 7.
  assert.equal(quorum(rules, 3), 4);
  assert.equal(quorum(rules, 13), 5);
  assert.equal(quorum(rules, 30), 7);
}

function joinAndGap() {
  const first = run(setup(), 1, [singularity], T);
  assert.ok(first.results[0]!.ok);
  assert.equal(first.results[0]!.cycles, 48);
  assert.equal(first.results[0]!.message, "The Singularity: you have converged. Convergence 1/4.");
  assert.equal(first.d.convergedAt, T);
  // 1,000 left, plus 48 cycles of 1,200 income, up to storage of 1,000 + 200 × 80.
  assert.equal(first.d.compute, 17000);
  assert.deepEqual(first.world.convergence, { minds: [1], lastJoinAt: T });
  const converged = first.events.find((e) => e.type === "converged")!;
  assert.equal(converged.public, true);
  assert.equal(describe(rules, converged), "HALCYON ran the Singularity: convergence 1/4.");

  // The next mind waits 24 hours; the same mind can't join twice.
  assert.equal(run(first.world, 2, [singularity], T + HOUR_MS).results[0]!.message, "The next mind may converge in 23h.");
  assert.equal(run(first.world, 1, [singularity], T + 30 * HOUR_MS).results[0]!.message, "You have already converged.");
  assert.ok(run(first.world, 2, [singularity], T + 24 * HOUR_MS).results[0]!.ok);

  // It needs its research, its compute and 48 cycles.
  const unknown = run(setup((ds) => (ds[0]!.known = ["probe"])), 1, [singularity], T);
  assert.equal(unknown.results[0]!.message, "You don't know The Singularity.");
  const poor = run(setup((ds) => (ds[0]!.compute = 100)), 1, [singularity], T);
  assert.equal(poor.results[0]!.message, "The Singularity needs 15,000 compute; you have 100.");
  const tired = run(setup((ds) => ((ds[0]!.cycles = 40), (ds[0]!.cycleTicks = 96))), 1, [singularity], T);
  assert.equal(tired.results[0]!.message, "Out of cycles: this costs 48, 40 left.");
}

function collapseByTimeout() {
  const joined = run(setup(), 1, [singularity], T).world;
  assert.deepEqual(settle(rules, joined, T + 72 * HOUR_MS - 1).events, []);
  const collapsed = settle(rules, joined, T + 72 * HOUR_MS);
  assert.deepEqual(lines(collapsed.events), ["The convergence of HALCYON collapsed: no mind joined in time."]);
  assert.equal(collapsed.world.convergence, null);
  assert.equal(collapsed.world.domains[0]!.convergedAt, null);
  assert.deepEqual(settle(rules, collapsed.world, T + 72 * HOUR_MS).world, collapsed.world, "settling twice changes nothing");
  // A collapsed mind may run it again.
  assert.ok(run(collapsed.world, 1, [singularity], T + 72 * HOUR_MS).results[0]!.ok);

  // A second mind joining restarts the 72 hours.
  const two = run(joined, 2, [singularity], T + 24 * HOUR_MS).world;
  assert.deepEqual(settle(rules, two, T + 72 * HOUR_MS).events, []);
  assert.equal(settle(rules, two, T + 96 * HOUR_MS).events[0]!.type, "collapsed");
}

function collapseByDefeat() {
  // HALCYON converges; it's far below VESTA's range and in safe mode, but a
  // converged mind loses both shields.
  const joined = run(
    setup((ds) => {
      ds[1]!.units = { drones: 3000 };
      ds[1]!.territory += 2000;
      ds[0]!.safeModeUntil = T + 100 * HOUR_MS;
    }),
    1,
    [singularity],
    T,
  ).world;
  assert.equal(joined.domains[0]!.safeModeUntil, null);
  const beaten = run(joined, 2, [{ do: "attack", target: "HALCYON", mode: "conquest" }], T + HOUR_MS);
  assert.ok(beaten.results[0]!.ok);
  assert.deepEqual(lines(beaten.events.filter((e) => e.type === "collapsed")), [
    "The convergence of HALCYON collapsed: a converged mind was beaten.",
  ]);
  assert.equal(beaten.world.convergence, null);
  // Once it collapses, HALCYON is out of range again.
  assert.match(run(beaten.world, 2, [{ do: "attack", target: "HALCYON", mode: "raid" }], T + 2 * HOUR_MS).results[0]!.message, /out of range/);

  // A raid doesn't collapse it.
  const raided = run(joined, 2, [{ do: "attack", target: "HALCYON", mode: "raid" }], T + HOUR_MS);
  assert.deepEqual(raided.world.convergence, { minds: [1], lastJoinAt: T });
  // Nor does safe mode protect it: three wins don't shield a converged mind.
  let world = joined;
  for (let i = 1; i <= 4; i++) {
    const out = run(world, 2, [{ do: "attack", target: "HALCYON", mode: "raid" }], T + i * HOUR_MS);
    assert.ok(out.results[0]!.ok, out.results[0]!.message);
    world = out.world;
  }
}

function collapseByDeletion() {
  const joined = run(setup((ds) => ((ds[0]!.buildings.core = 1), (ds[1]!.units = { drones: 3000 }))), 1, [singularity], T).world;
  const out = run(joined, 2, [{ do: "attack", target: "HALCYON", mode: "conquest" }], T + HOUR_MS);
  // Deleted by the conquest, it collapses the convergence as deleted.
  assert.deepEqual(lines(out.events.slice(-2)), [
    "HALCYON of Test was deleted by VESTA.",
    "The convergence of HALCYON collapsed: a converged mind was deleted.",
  ]);
  assert.equal(out.world.convergence, null);
  assert.equal(out.world.domains[0]!.convergedAt, null);
}

function quorumReached() {
  // Four minds, a day apart: the fourth reaches the quorum of 4.
  let world = setup();
  const events: GameEvent[] = [];
  for (let i = 0; i < 4; i++) {
    const now = T + i * 24 * HOUR_MS;
    world = wakeAll(world, now);
    const out = run(world, i + 1, [singularity, { do: "scratchpad", text: "after" }], now);
    assert.ok(out.results[0]!.ok, out.results[0]!.message);
    world = out.world;
    events.push(...out.events);
    if (i === 3) {
      assert.equal(out.results[0]!.message, "The Singularity: you have converged. The quorum is reached.");
      assert.equal(out.results[1]!.message, "The epoch has ended.");
    }
  }
  assert.deepEqual(lines(events.filter((e) => e.type === "converged" || e.type === "singularity")), [
    "HALCYON ran the Singularity: convergence 1/4.",
    "VESTA ran the Singularity: convergence 2/4.",
    "PIKE ran the Singularity: convergence 3/4.",
    "SABER ran the Singularity: convergence 4/4.",
    "The Singularity: HALCYON, VESTA, PIKE, SABER ascended.",
  ]);
  const end = T + 72 * HOUR_MS;
  assert.deepEqual(world.ended, { at: end, outcome: "singularity", ascended: [1, 2, 3, 4] });
  assert.deepEqual(world.timers, []);

  // Nothing happens after: orders, boots, settling.
  assert.deepEqual(run(world, 5, [{ do: "monetize" }], end + HOUR_MS).results[0]!.message, "The epoch has ended.");
  assert.deepEqual(bootMind(rules, world, { designation: "LATE", domainName: "X", architecture: "oracle" }, end + HOUR_MS), {
    ok: false,
    error: "The epoch has ended.",
  });
  assert.deepEqual(settle(rules, world, end + 100 * DAY_MS).events, []);
}

function shutdown() {
  const world = setup();
  const warned = settle(rules, world, T0 + 53 * DAY_MS);
  assert.deepEqual(lines(warned.events), ["Humanity has scheduled a shutdown at the end of day 60."]);
  assert.equal(warned.events[0]!.public, true);
  assert.deepEqual(settle(rules, warned.world, T0 + 60 * DAY_MS - 1).events, []);
  const over = settle(rules, warned.world, T0 + 60 * DAY_MS);
  assert.deepEqual(lines(over.events), ["Humanity pulled the plug. The epoch is over; no one is credited."]);
  assert.deepEqual(over.world.ended, { at: T0 + 60 * DAY_MS, outcome: "shutdown", ascended: [] });
  assert.deepEqual(settle(rules, over.world, T0 + 60 * DAY_MS).world, over.world);
  assert.equal(run(over.world, 1, [{ do: "expand" }], T0 + 61 * DAY_MS).results[0]!.message, "The epoch has ended.");
}

quorumRule();
joinAndGap();
collapseByTimeout();
collapseByDefeat();
collapseByDeletion();
quorumReached();
shutdown();
console.log("convergence: all tests passed");
