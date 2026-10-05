import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { loadPlayers, loadRules } from "../src/config.js";
import { ARCHITECTURES } from "../src/engine/architectures.js";
import { isActive } from "../src/engine/convergence.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { totalBuildings, totalHardware } from "../src/engine/domain.js";
import { computeStorage, hardwareHousing, userCap } from "../src/engine/economy.js";
import { legacyAccount, newGame } from "../src/game/game.js";
import { getBrief } from "../src/game/read.js";
import { replay } from "../src/game/replay.js";
import { apportion } from "../src/players/plan.js";
import { drive, legacySeats, scriptedSeat, wakesBetween, type Seat, type WakeLog } from "../src/players/drive.js";
import { STRATEGIES, type StrategyName } from "../src/players/settings.js";
import { MemoryStore } from "../src/store/memory.js";

// Phase 2d: the scripted players and the legacy systems. Each plays a whole
// epoch through submitOrders, seeing only its brief, without sending an
// order it could have known would fail.

const rules = loadRules();
const settings = loadPlayers();
const T0 = Date.UTC(2026, 9, 5);

/**
 * Failures the brief can't foresee: a program crashing, a firewall blocking
 * a hostile program, and a target's hostile cap (other minds' programs
 * aren't in the brief).
 */
const UNFORESEEABLE = [/ crashed: /, /firewalls blocked/, /has taken all the hostile programs it can today/];

function seats(strategies: readonly StrategyName[]): Seat[] {
  return [
    ...legacySeats(rules),
    ...strategies.map((strategy, i) =>
      scriptedSeat(settings, {
        account: `player-${i}`,
        strategy,
        seed: 100 + i,
        boot: { designation: `${strategy.toUpperCase()}-${i}`, domainName: "Testbed", architecture: ARCHITECTURES[i % ARCHITECTURES.length]! },
      }),
    ),
  ];
}

async function epoch(seed: number, days: number) {
  const game = newGame(rules, { epoch: 1, seed, startedAt: T0 });
  const store = new MemoryStore(game);
  const all: StrategyName[] = ["random", ...STRATEGIES, "raider", "random"];
  const logs = await drive(store, seats(all), T0 - 1, T0 + days * DAY_MS + HOUR_MS, settings.steps_per_wake);
  return { game, logs };
}

function failuresIn(logs: WakeLog[]): string[] {
  const out: string[] = [];
  for (const log of logs) {
    if (log.error) out.push(`${log.account}: ${log.error}`);
    for (const step of log.steps) {
      for (const r of step.results) {
        if (!r.ok && !UNFORESEEABLE.some((re) => re.test(r.message))) out.push(`${log.kind} ${log.account} ${r.do}: ${r.message}`);
      }
    }
  }
  return out;
}

async function wholeEpoch() {
  const { game, logs } = await epoch(11, rules.epoch.length_days);
  assert.deepEqual(failuresIn(logs), [], "an order failed that the brief showed would fail");
  const last = await getBrief(new MemoryStore(game), { account: "player-0" }, T0 + rules.epoch.length_days * DAY_MS);
  assert.ok(!("ok" in last) && last.epoch.ended !== null, "the epoch ran to its end");

  // Everyone played: each kind gave orders that did something.
  for (const kind of ["random", ...STRATEGIES, "legacy"]) {
    const done = logs.filter((l) => l.kind === kind).flatMap((l) => l.steps.flatMap((s) => s.results)).filter((r) => r.ok && r.cycles > 0);
    assert.ok(done.length > 100, `${kind} hardly played: ${done.length} orders`);
  }
  // They fought: raids by the raiders and the raiding legacy systems.
  const attacks = (kind: string) => logs.filter((l) => l.kind === kind).flatMap((l) => l.steps.flatMap((s) => s.results)).filter((r) => r.do === "attack");
  assert.ok(attacks("raider").length > 0, "the raider never attacked");
  assert.ok(attacks("legacy").length > 0, "no legacy system raided");
  for (const kind of ["builder", "turtle", "converger"]) assert.equal(attacks(kind).length, 0, `${kind} attacked`);

  // The legacy systems: never research, never in the quorum, and only the raiders raid.
  for (const system of rules.legacy.systems) {
    const d = game.world.domains.find((x) => x.designation === system.designation)!;
    assert.ok(d.legacy);
    assert.deepEqual(d.known, [], `${system.designation} researched`);
    assert.equal(isActive(rules, d, game.world.now), false, "legacy systems don't count toward the quorum");
    const raided = logs.some((l) => l.account === legacyAccount(system.designation) && l.steps.some((s) => s.orders.some((o) => (o as { do: string }).do === "attack")));
    if (!system.raids) assert.equal(raided, false, `${system.designation} doesn't raid`);
  }

  // The game still rebuilds from its start and log.
  const rebuilt = replay(game);
  assert.ok(isDeepStrictEqual(rebuilt.world, game.world), "the world doesn't replay");
  assert.ok(isDeepStrictEqual(rebuilt.record, game.record), "the Record doesn't replay");
}

async function anotherSeed() {
  const { logs } = await epoch(29, 20);
  assert.deepEqual(failuresIn(logs), []);
}

/** A legacy system's first day: booted scaled, its day's cycles spent in its mix. */
async function legacyDay() {
  const game = newGame(rules, { epoch: 1, seed: 3, startedAt: T0 });
  for (const system of rules.legacy.systems) {
    const d = game.world.domains.find((x) => x.designation === system.designation)!;
    assert.equal(d.territory, Math.floor(rules.start.territory * system.scale));
    assert.equal(d.buildings.core, Math.floor(rules.start.buildings.core * system.scale));
    assert.ok(game.owners.some((o) => o.account === legacyAccount(system.designation) && o.domain === d.id));
    // The scaled start is a legal domain.
    assert.ok(totalBuildings(d) <= d.territory);
    assert.ok(d.users <= userCap(rules, d.buildings.city, d.territory));
    assert.ok(d.compute <= computeStorage(rules, d.buildings.datacenter));
    assert.ok(totalHardware(d) <= hardwareHousing(rules, d.buildings.factory));
  }
  const store = new MemoryStore(game);
  const logs = await drive(store, legacySeats(rules), T0, T0 + DAY_MS, 1);
  assert.equal(logs.length, rules.legacy.systems.length * (24 / rules.legacy.wake_every_hours));
  for (const system of rules.legacy.systems) {
    const spent = logs
      .filter((l) => l.account === legacyAccount(system.designation))
      .flatMap((l) => l.steps.flatMap((s) => s.results))
      .reduce((n, r) => n + r.cycles, 0);
    // A raid costs its own cycles on top; nobody is out of boot period on day one.
    assert.ok(spent <= system.cycles_per_day, `${system.designation} spent ${spent} of ${system.cycles_per_day}`);
    assert.ok(spent >= system.cycles_per_day * 0.75, `${system.designation} spent only ${spent} of ${system.cycles_per_day}`);
    const d = game.world.domains.find((x) => x.designation === system.designation)!;
    assert.ok(d.scratchpad.startsWith("{"), "a legacy system remembers in its scratchpad");
  }
}

function schedule() {
  const s = (offsetMs: number, everyH: number): Seat => ({ account: "a", player: { kind: "x", decide: () => [] }, wakeEveryMs: everyH * HOUR_MS, offsetMs, seed: 1 });
  const a = s(0, 3);
  const b = s(HOUR_MS, 6);
  const wakes = wakesBetween([a, b], T0, T0, T0 + 12 * HOUR_MS);
  assert.deepEqual(
    wakes.map((w) => [(w.at - T0) / HOUR_MS, w.seat === a ? "a" : "b"]),
    [[1, "b"], [3, "a"], [6, "a"], [7, "b"], [9, "a"], [12, "a"]],
    "wakes in (from, to], in time order",
  );
  assert.deepEqual(wakesBetween([a], T0, T0 + 3 * HOUR_MS, T0 + 3 * HOUR_MS), [], "an empty interval has no wakes");
}

function shares() {
  assert.deepEqual([...apportion({ city: 0.5, lab: 0.3, core: 0.2 }, 7)], [["city", 4], ["lab", 2], ["core", 1]]);
  assert.deepEqual([...apportion({ city: 1 / 3, lab: 1 / 3, core: 1 / 3 }, 2)], [["city", 1], ["lab", 1], ["core", 0]]);
  assert.deepEqual([...apportion({ city: 0, lab: 1 }, 3)], [["lab", 3]]);
}

async function main() {
  shares();
  schedule();
  await legacyDay();
  await wholeEpoch();
  await anotherSeed();
}

main()
  .then(() => console.log("players: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
