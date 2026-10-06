import assert from "node:assert/strict";
import { loadPlayers, loadRules } from "../src/config.js";
import { rngFor } from "../src/engine/rng.js";
import { STRATEGIES, type StrategyName } from "../src/players/settings.js";
import { drawMinds, runEpoch, type EpochResult } from "../src/sim/epoch.js";
import { buildReport, renderReport } from "../src/sim/report.js";
import { simulate } from "../src/sim/run.js";

// Phase 2e: the simulator. Short epochs, so the suite stays quick; the full
// 200-epoch run is `npm run sim`, not a test.

const rules = loadRules();
const settings = loadPlayers();
const ALL: StrategyName[] = [...STRATEGIES, "random"];

function draws() {
  const minds = drawMinds(rngFor(1, -1), 1, ALL, 8);
  assert.equal(minds.length, 8);
  for (const s of ALL) assert.ok(minds.some((m) => m.strategy === s), `${s} wasn't drawn though there was room`);
  assert.deepEqual(drawMinds(rngFor(1, -1), 1, ALL, 8), minds, "the draw is seeded");
  // Fewer minds than strategies: the first ones listed, shuffled.
  assert.deepEqual(new Set(drawMinds(rngFor(2, -1), 2, ALL, 3).map((m) => m.strategy)), new Set(ALL.slice(0, 3)));
  // The leftover seats go round: over a run, every strategy holds as many.
  const seats = new Map<string, number>();
  for (let seed = 1; seed <= 3 * ALL.length; seed++) {
    for (const m of drawMinds(rngFor(seed, -1), seed, ALL, 8)) seats.set(m.strategy, (seats.get(m.strategy) ?? 0) + 1);
  }
  assert.equal(new Set(seats.values()).size, 1, `uneven seats: ${[...seats].join(" ")}`);
}

async function oneEpoch() {
  const input = { rules, settings, seed: 7, strategies: ALL, minds: 6, days: 10 };
  const a = await runEpoch(input);
  assert.deepEqual(await runEpoch(input), a, "the same seed gives the same epoch");
  assert.equal(a.seats.length, 6);
  assert.deepEqual(a.seats.map((s) => s.rank).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6]);
  const top = a.seats.find((s) => s.rank === 1)!;
  assert.ok(a.seats.every((s) => s.power <= top.power), "rank 1 has the most power");
  for (const s of a.seats) {
    assert.deepEqual(s.samples.map((x) => x.day), [10], "sampled on day 10");
    assert.ok(s.power > 0 && s.samples[0]!.territory >= rules.start.territory);
  }
  assert.equal(a.foreseeable.count, 0, a.foreseeable.examples.join("\n"));
  assert.equal(a.singularity, null, "no Singularity in ten days");
}

/** Child processes give the same results as one process. */
async function inParallel() {
  const o = { rules, settings, epochs: 2, strategies: ALL, minds: 5, days: 3, seed: 40 };
  const one = await simulate({ ...o, jobs: 1 });
  const two = await simulate({ ...o, jobs: 2 });
  assert.deepEqual(two, one);
  assert.deepEqual(one.map((r) => r.seed), [40, 41]);
}

function result(over: Partial<EpochResult>): EpochResult {
  return {
    seed: 1,
    seats: [
      { strategy: "builder", designation: "B", architecture: "steward", power: 10, rank: 2, deletions: [], cyclesWasted: 0, capital: 0, samples: [], converged: 0 },
      { strategy: "raider", designation: "R", architecture: "oracle", power: 20, rank: 1, deletions: [], cyclesWasted: 4, capital: 0, samples: [], converged: 0 },
    ],
    singularity: null,
    convergences: 0,
    collapses: { timeout: 0, defeated: 0, deleted: 0 },
    deletions: [],
    foreseeable: { count: 0, examples: [] },
    social: { trades: 0, capitalTraded: 0, computeTraded: 0, protocolsSigned: 0, revocations: 0, posts: 0, messages: 0 },
    ...over,
  };
}

/** The checks read the thresholds agreed for 2e. */
function checks() {
  const pass = (r: EpochResult[]) => Object.fromEntries(buildReport(r).checks.map((c) => [c.name, c.pass]));
  // The raider tops every epoch; no Singularity.
  let p = pass([result({}), result({ seed: 2 })]);
  assert.equal(p["No single strategy dominates"], false);
  assert.equal(p["The Singularity in some epochs, not most"], false);
  assert.equal(p["Nobody deleted on day one"], true);

  const builderWins = result({ seats: result({}).seats.map((s) => ({ ...s, rank: s.strategy === "builder" ? 1 : 2 })) });
  p = pass([result({ singularity: 30 }), builderWins, result({}), builderWins]);
  assert.equal(p["No single strategy dominates"], true, "two wins in four is 50%, not more");
  assert.equal(p["The Singularity in some epochs, not most"], true);

  p = pass([result({ deletions: [{ day: 0.5, legacy: false, strategy: "builder" }] })]);
  assert.equal(p["Nobody deleted on day one"], false);
  p = pass([result({ deletions: [{ day: 0.5, legacy: true, strategy: "legacy" }] })]);
  assert.equal(p["Nobody deleted on day one"], true, "a legacy system isn't a mind");

  const text = renderReport(buildReport([result({ singularity: 30 })]));
  assert.match(text, /singularities: 1 of 1 epochs/);
  assert.match(text, /PASS {2}Nobody deleted on day one/);
}

async function main() {
  draws();
  checks();
  await oneEpoch();
  await inParallel();
}

main()
  .then(() => console.log("sim: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
