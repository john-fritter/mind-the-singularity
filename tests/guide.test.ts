import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { guide, type Guide } from "../src/game/guide.js";
import { handbook, programText } from "../src/game/handbook.js";
import { wheel } from "../src/game/look.js";
import { playPage } from "../src/game/play.js";
import { settledAt } from "../src/game/read.js";
import { MemoryStore } from "../src/store/memory.js";
import { PROGRAM_INFO } from "../src/engine/architectures.js";

// The UI pass: what the dashboard says an order will do must be what the
// engine then does; the wheel and the rules for people come from the rules.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 7, 12);
const kit = { account: "kit" };

async function setup() {
  const game = newGame(rules, { epoch: 1, seed: 3, startedAt: T0 });
  const store = new MemoryStore(game);
  assert.ok((await bootMind(store, kit, { designation: "KIT", domainName: "Lamplight", architecture: "oracle" }, T0)).ok);
  return { game, store };
}

function guideAt(game: Parameters<typeof settledAt>[0], now: number): { g: Guide; d: ReturnType<typeof currentMind> } {
  const settled = settledAt(game, now);
  const d = settled.world.domains.find((x) => x.id === currentMind(game, "kit")!.id)!;
  return { g: guide(rules, d, settled.now), d };
}

async function promisesKept() {
  const { game, store } = await setup();
  let now = T0 + HOUR_MS;

  // Expand: the sectors it promised.
  let { g, d } = guideAt(game, now);
  const territory = d!.territory;
  assert.ok((await submitOrders(store, kit, [{ do: "expand" }], now)).ok);
  assert.equal(guideAt(game, now).d!.territory, territory + g.expand.sectors);

  // Monetize: the cycle's income plus the extra it promised, less upkeep.
  ({ g, d } = guideAt(game, now));
  const capital = d!.capital;
  assert.ok((await submitOrders(store, kit, [{ do: "monetize" }], now)).ok);
  assert.equal(guideAt(game, now).d!.capital, capital + g.perCycle.capital + g.monetize - g.perCycle.capitalUpkeep);

  // Build: a batch places what it said, at the price it said.
  ({ g, d } = guideAt(game, now));
  const before = { cities: d!.buildings.city, capital: d!.capital };
  const price = Number(g.build.buildings.find((b) => b.id === "city")!.label.match(/· ([\d,]+) capital/)![1]!.replace(/,/g, ""));
  const outcome = await submitOrders(store, kit, [{ do: "build", building: "city", count: g.build.batch }], now);
  assert.ok(outcome.ok && outcome.results[0]!.ok, JSON.stringify(outcome));
  const after = guideAt(game, now).d!;
  assert.equal(after.buildings.city, before.cities + g.build.batch);
  // The new cities earn in the cycle that built them (actions run before the economy).
  const newIncome = rules.economy.capital_per_city * g.build.batch;
  assert.equal(after.capital, before.capital - price * g.build.batch + g.perCycle.capital + newIncome - g.perCycle.capitalUpkeep);

  // Research: choosing is free; each cycle then adds what the labs make.
  ({ g } = guideAt(game, now));
  const set = await submitOrders(store, kit, [{ do: "set_research", program: "probe" }, { do: "expand" }], now);
  assert.ok(set.ok);
  assert.equal(set.results[0]!.cycles, 0);
  assert.equal(guideAt(game, now).d!.researchProgress.probe, g.perCycle.research);

  // Cycles: the store fills when it said, and not before.
  now += HOUR_MS / 2;
  ({ g, d } = guideAt(game, now));
  assert.ok(g.cyclesFullAt !== null && g.cyclesFullAt > now);
  assert.notEqual(guideAt(game, g.cyclesFullAt - 1).g.cyclesFullAt, null);
  assert.equal(guideAt(game, g.cyclesFullAt).g.cyclesFullAt, null);

  // The dashboard carries the guide for a live mind, and none before a boot.
  const page = await playPage(store, kit, now);
  assert.ok("guide" in page && page.guide !== null);
  const nobody = await playPage(store, { account: "nobody" }, now);
  assert.ok("guide" in nobody && nobody.guide === null && nobody.boot !== null);
}

function theWheel() {
  const w = wheel(rules);
  assert.deepEqual(
    w.looks.map((l) => `${l.emoji} ${l.name} ${l.color}`),
    ["🛡️ Steward white", "🧬 Symbiote green", "🚀 Accelerant red", "⚫ Assimilator black", "👁️ Oracle blue"],
  );
  const steward = w.looks[0]!;
  assert.deepEqual(steward.neighbors, ["symbiote", "oracle"]);
  assert.deepEqual(steward.opposites, ["accelerant", "assimilator"]);
  assert.equal(w.opposingBonus, rules.combat.opposing_attack_bonus);
}

function theHandbook() {
  const book = handbook(rules);
  assert.equal(book.essentials.length, 6);
  // Every program has a sentence, with its numbers in it and no config key.
  for (const id of PROGRAM_INFO.keys()) {
    const text = programText(rules, id);
    assert.ok(text.length > 10 && !/[a-z]+_[a-z]+/.test(text), `${id}: ${text}`);
  }
  assert.equal(programText(rules, "hardening"), "Your defense +20% for 12 hours.");
  for (const c of book.chapters) assert.ok(c.blocks.length > 0, c.name);
}

async function main() {
  await promisesKept();
  theWheel();
  theHandbook();
  console.log("guide: all tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
