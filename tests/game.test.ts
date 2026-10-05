import assert from "node:assert/strict";
import { loadRules, loadSite } from "../src/config.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, view, type Brief } from "../src/game/read.js";
import type { GameError } from "../src/game/state.js";
import { MemoryStore } from "../src/store/memory.js";

// The game layer (phase 2c): who may boot and give orders, the log every
// write leaves, writes one at a time, and reads that settle without saving.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const HALCYON = { designation: "HALCYON", domainName: "Glasswater", architecture: "symbiote" };
const VESTA = { designation: "VESTA", domainName: "Hearth", architecture: "steward" };
const john = { account: "john" };
const ada = { account: "ada" };

function fresh() {
  const game = newGame(rules, { epoch: 1, seed: 5, startedAt: T0 });
  return { game, store: new MemoryStore(game) };
}

function isError(x: unknown, code: GameError["code"]) {
  assert.ok(typeof x === "object" && x !== null && (x as GameError).ok === false, `expected an error, got ${JSON.stringify(x)}`);
  assert.equal((x as GameError).code, code, (x as GameError).error);
}

function brief(x: Brief | GameError): Brief {
  assert.ok(!("ok" in x), "expected a brief");
  return x as Brief;
}

async function access() {
  const { game, store } = fresh();
  isError(await submitOrders(store, john, [{ do: "expand" }], T0), "not_found");
  isError(await getBrief(store, john, T0), "not_found");
  isError(await bootMind(store, { account: "  " }, HALCYON, T0), "invalid");
  isError(await bootMind(store, john, { ...HALCYON, architecture: "lizard" }, T0), "invalid");
  assert.equal(game.log.length, 0, "refused calls aren't logged");

  const booted = await bootMind(store, john, HALCYON, T0);
  assert.ok(booted.ok);
  assert.equal(booted.status.cycles, rules.cycles.cap);
  isError(await bootMind(store, john, VESTA, T0), "refused");
  isError(await bootMind(store, ada, { ...HALCYON, domainName: "Elsewhere" }, T0), "invalid");
  assert.ok((await bootMind(store, ada, VESTA, T0)).ok);
  assert.deepEqual(game.owners, [
    { account: "john", domain: 1 },
    { account: "ada", domain: 2 },
  ]);

  // An account gives orders to its own mind and no other.
  const out = await submitOrders(store, ada, [{ do: "expand", cycles: 2 }], T0 + HOUR_MS);
  assert.ok(out.ok);
  assert.equal(out.status.designation, "VESTA");
  assert.equal(game.world.domains[0]!.territory, rules.start.territory, "john's mind is untouched");
  isError(await submitOrders(store, ada, { do: "expand" }, T0 + HOUR_MS), "invalid");

  // The clock never runs backward.
  isError(await submitOrders(store, ada, [{ do: "expand" }], T0), "invalid");
  isError(await bootMind(store, { account: "kit" }, { ...VESTA, designation: "KIT" }, T0), "invalid");

  assert.deepEqual(
    game.log.map((e) => [e.kind, e.account, e.domain]),
    [
      ["boot", "john", 1],
      ["boot", "ada", 2],
      ["orders", "ada", 2],
    ],
  );
  const last = game.log.at(-1)!;
  assert.ok(last.kind === "orders");
  assert.deepEqual(last.orders, [{ do: "expand", cycles: 2 }]);
  assert.equal(last.seq, game.world.seq);
  assert.ok(last.results[0]!.ok);
}

async function reboot() {
  const { game, store } = fresh();
  assert.ok((await bootMind(store, john, HALCYON, T0)).ok);
  // Deleted by some battle (conflict.test.ts covers how).
  const deletedAt = T0 + 5 * DAY_MS;
  const mind = currentMind(game, "john")!;
  mind.buildings.core = 0;
  mind.deletedAt = deletedAt;

  const orders = await submitOrders(store, john, [{ do: "expand" }], deletedAt + HOUR_MS);
  assert.ok(orders.ok && !orders.results[0]!.ok, "a deleted mind can't act");
  const b = brief(await getBrief(store, john, deletedAt + HOUR_MS));
  assert.equal(b.you.deletedAt, deletedAt);
  assert.equal(b.you.rebootAt, deletedAt + rules.deletion.reboot_after_hours * HOUR_MS);
  assert.deepEqual(b.inRange, []);

  isError(await bootMind(store, john, { ...HALCYON, domainName: "Again" }, deletedAt + 2 * HOUR_MS), "refused");
  const again = await bootMind(store, john, { ...HALCYON, domainName: "Again" }, deletedAt + rules.deletion.reboot_after_hours * HOUR_MS);
  assert.ok(again.ok, "the same account boots again after the wait, under the same designation");
  assert.equal(currentMind(game, "john")!.id, 2);
  assert.equal(currentMind(game, "john")!.domainName, "Again");
}

async function oneAtATime() {
  const { game, store } = fresh();
  assert.ok((await bootMind(store, john, HALCYON, T0)).ok);
  const outs = await Promise.all(Array.from({ length: 10 }, () => submitOrders(store, john, [{ do: "monetize" }], T0 + HOUR_MS)));
  assert.ok(outs.every((o) => o.ok && o.results[0]!.ok));
  assert.equal(game.log.length, 11);
  assert.equal(game.world.domains[0]!.cycles, rules.cycles.cap - 10, "every write saw the one before");
  const seqs = game.log.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  // A write that throws doesn't jam the queue.
  await assert.rejects(store.update(() => {
    throw new Error("boom");
  }));
  assert.ok((await submitOrders(store, john, [{ do: "monetize" }], T0 + HOUR_MS)).ok);
}

async function readsDontWrite() {
  const { game, store } = fresh();
  assert.ok((await bootMind(store, john, HALCYON, T0)).ok);
  assert.ok((await submitOrders(store, john, [{ do: "expand" }], T0)).ok);
  const saved = JSON.stringify(game);

  // Past the Shutdown's warning: a read shows it, but saves nothing.
  const warnAt = T0 + (rules.epoch.length_days - rules.epoch.shutdown_warning_days) * DAY_MS;
  const later = warnAt + HOUR_MS;
  const b = brief(await getBrief(store, john, later));
  const warning = b.since.events.find((e) => e.type === "shutdown_warning");
  assert.ok(warning, "the brief shows a timer that fired since");
  assert.equal(b.epoch.day, rules.epoch.length_days - rules.epoch.shutdown_warning_days + 1);
  const record = await view(store, ada, { what: "record", type: "shutdown_warning" }, later);
  assert.ok(record.ok && record.what === "record" && record.entries.length === 1);
  await view(store, ada, { what: "rankings" }, later);
  assert.equal(JSON.stringify(game), saved, "a read changed the game");

  // The next write settles to the same result, under the same sequence number.
  assert.ok((await submitOrders(store, john, [{ do: "monetize" }], later)).ok);
  const recorded = game.record.find((e) => e.type === "shutdown_warning")!;
  assert.deepEqual({ ...recorded, text: warning.text }, warning);
  // Reading at a time before the game's clock reads it as it is now.
  assert.equal(brief(await getBrief(store, john, T0)).now, later);

  // "Since last wake" is since the mind's last orders.
  assert.deepEqual(brief(await getBrief(store, john, later)).since.events, []);
}

async function views() {
  const { store } = fresh();
  assert.ok((await bootMind(store, john, HALCYON, T0)).ok);
  assert.ok((await bootMind(store, ada, { ...VESTA, manifesto: "Hold." }, T0)).ok);
  assert.ok((await submitOrders(store, ada, [{ do: "expand", cycles: 10 }], T0)).ok);

  const ranks = await view(store, john, { what: "rankings" }, T0);
  assert.ok(ranks.ok && ranks.what === "rankings");
  assert.deepEqual(ranks.domains.map((d) => [d.rank, d.designation, d.status]), [
    [1, "VESTA", "boot period"],
    [2, "HALCYON", "boot period"],
  ]);
  const page = await view(store, john, { what: "domain", name: "vesta" }, T0 + 3 * DAY_MS);
  assert.ok(page.ok && page.what === "domain");
  assert.equal(page.domain.manifesto, "Hold.");
  assert.equal(page.domain.status, "active");
  isError(await view(store, john, { what: "domain", name: "PIKE" }, T0), "not_found");
  isError(await view(store, john, { what: "record", mind: "PIKE" }, T0), "not_found");
  isError(await view(store, john, { what: "archive" }, T0), "invalid");

  const one = await view(store, john, { what: "record", limit: 1 }, T0);
  assert.ok(one.ok && one.what === "record");
  assert.deepEqual(one.entries.map((e) => ("designation" in e ? e.designation : null)), ["VESTA"]);
  assert.equal(one.more, true);
  const older = await view(store, john, { what: "record", before: one.entries[0]!.seq }, T0);
  assert.ok(older.ok && older.what === "record");
  assert.deepEqual(older.entries.map((e) => e.text), ["HALCYON of Glasswater came online: a Symbiote mind."]);
  const capped = await view(store, john, { what: "record", limit: 10 ** 6 }, T0);
  assert.ok(capped.ok && capped.what === "record" && capped.entries.length <= loadSite().view.record_max);
}

async function main() {
  await access();
  await reboot();
  await oneAtATime();
  await readsDontWrite();
  await views();
}

main().then(
  () => console.log("game: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
