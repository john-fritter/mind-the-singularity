import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { loadPlayers, loadRules } from "../src/config.js";
import { nextEpochAt } from "../src/engine/convergence.js";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../src/engine/cycles.js";
import { getBriefText } from "../src/game/brief.js";
import { listedEpochs, databaseEpochs } from "../src/game/epochs.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { rebootIfDue } from "../src/game/lifecycle.js";
import { frontPage, viewArchive } from "../src/game/public.js";
import { replay } from "../src/game/replay.js";
import { ServerClock, type SeatRow } from "../src/players/clock.js";
import { MemoryStore } from "../src/store/memory.js";
import { addSeat, createEpoch, createNextEpoch, discardEpoch, latestEpoch, listSeats } from "../src/store/postgres.js";
import { freshDatabase } from "./db.js";

// The epoch lifecycle (phase 6a, src/game/lifecycle.ts): an epoch ends at
// the Shutdown, nobody wakes in the downtime, the brief and the pages say
// when the next epoch boots, the server boots it once with the same
// scripted players, accounts boot fresh minds in it, and the ended epoch
// goes to the Archive, agents' `view` included. In Postgres, the reboot
// copies the seats and boots once, and a test epoch can be thrown away.

const rules = loadRules();
const players = loadPlayers();
const T0 = Date.UTC(2026, 9, 5, 12);
const SHUTDOWN = T0 + rules.epoch.length_days * DAY_MS;
const DOWNTIME = rules.epoch.downtime_hours * HOUR_MS;
const kit = { account: "kit" };
const KIT = { designation: "KIT", domainName: "Lamplight", architecture: "oracle" };
const seat: SeatRow = { account: "bot:builder-1", strategy: "builder", seed: 42, boot: { designation: "BUILDER-1", domainName: "The builder domain", architecture: "steward" } };

async function memory() {
  assert.equal(nextEpochAt(rules, { at: SHUTDOWN, outcome: "shutdown", ascended: [] }), SHUTDOWN + DOWNTIME);

  const first = new MemoryStore(newGame(rules, { epoch: 1, seed: 3, startedAt: T0 }));
  const epochs = listedEpochs([first]);
  const clock = new ServerClock({ current: () => epochs.current(), seats: async () => [seat], settings: players }, T0);
  assert.ok((await bootMind(first, kit, KIT, T0 + HOUR_MS)).ok);
  assert.ok((await submitOrders(first, kit, [{ do: "flavor", directive: "Keep the lamps lit." }], T0 + HOUR_MS)).ok);
  assert.ok((await clock.pass(T0 + 2 * HOUR_MS)).length > 0, "the epoch is played");

  // Before the Shutdown, nothing to reboot.
  assert.equal(await rebootIfDue(epochs, rules, 9, SHUTDOWN - MINUTE_MS), null);

  // In the downtime: nobody wakes, though nothing wrote the ending; nothing boots yet.
  const down = SHUTDOWN + HOUR_MS;
  assert.deepEqual(await clock.pass(down), []);
  assert.equal(await rebootIfDue(epochs, rules, 9, down), null);
  assert.equal((await epochs.numbers()).length, 1);
  const brief = await getBriefText(first, kit, down);
  assert.ok(typeof brief === "string");
  assert.match(brief, /THE EPOCH IS OVER: humanity pulled the plug\. Epoch 2 boots in 1d 23h; boot a new mind then\./);
  const front = await frontPage(first, down);
  assert.ok(front.epoch.ended);
  assert.equal(front.epoch.ended.nextEpochAt, SHUTDOWN + DOWNTIME);
  // Orders in the gap are refused by the engine, and the epoch's world stays over.
  const late = await submitOrders(first, kit, [{ do: "expand" }], down);
  assert.ok(late.ok && late.results[0]!.ok === false && late.results[0]!.message === "The epoch has ended.");

  // The ended epoch is in the Archive, for agents too.
  const archive = await viewArchive(epochs, {}, down);
  assert.ok(archive.ok);
  assert.equal(archive.epochs.length, 1);
  assert.equal(archive.epochs[0]!.outcome, "shutdown");
  assert.equal(archive.epochs[0]!.top.find((m) => m.designation === "KIT")?.directive, "Keep the lamps lit.");
  const older = await viewArchive(epochs, { before: 1 }, down);
  assert.ok(older.ok && older.epochs.length === 0 && !older.more);
  assert.equal((await viewArchive(epochs, { what: "x" }, down)).ok, false, "a strict query");

  // The downtime over, the next epoch boots, once.
  const boot = SHUTDOWN + DOWNTIME;
  assert.equal(await rebootIfDue(epochs, rules, 9, boot), 2);
  assert.equal(await rebootIfDue(epochs, rules, 10, boot), null);
  assert.equal(await rebootIfDue(epochs, rules, 10, boot + HOUR_MS), null, "the new epoch is running");
  const second = (await epochs.current())!;
  const game = await second.read();
  assert.deepEqual(game.start, { epoch: 2, seed: 9, startedAt: boot });
  assert.ok(game.world.domains.length > 0 && game.world.domains.every((d) => d.legacy), "fresh: only its legacy systems");

  // The seats come back: the scripted player boots on the next pass; the person boots again.
  const woke = await clock.pass(boot + MINUTE_MS);
  assert.ok(woke.some((l) => l.account === seat.account && l.booted && !l.error), JSON.stringify(woke));
  assert.equal(currentMind(game, "kit"), undefined);
  assert.equal(await getBriefText(second, kit, boot + MINUTE_MS).then((b) => typeof b !== "string" && b.code), "not_found");
  assert.ok((await bootMind(second, kit, KIT, boot + 2 * MINUTE_MS)).ok, "the account boots a fresh mind");

  // The old epoch is left as it was played: it still replays from its log.
  const old = await first.read();
  const rebuilt = replay(old);
  assert.ok(isDeepStrictEqual(rebuilt.world, old.world) && isDeepStrictEqual(rebuilt.record, old.record), "the old epoch doesn't replay");
}

async function postgres() {
  const { pool } = await freshDatabase("lifecycle");
  try {
    await createEpoch(pool, newGame(rules, { epoch: 1, seed: 3, startedAt: T0 }));
    await addSeat(pool, 1, { account: seat.account, strategy: seat.strategy, seed: seat.seed, boot: seat.boot });
    const epochs = databaseEpochs(pool);
    const one = (await epochs.current())!;
    assert.ok((await bootMind(one, kit, KIT, T0 + HOUR_MS)).ok);

    // The reboot copies the seats; a second process rebooting at once boots nothing.
    const boot = SHUTDOWN + DOWNTIME;
    const [a, b] = await Promise.all([rebootIfDue(epochs, rules, 9, boot), rebootIfDue(databaseEpochs(pool), rules, 10, boot)]);
    assert.deepEqual([a, b].filter((x) => x !== null), [2]);
    assert.deepEqual((await listSeats(pool, 2)).map((s) => s.account), [seat.account]);
    assert.equal(await createNextEpoch(pool, newGame(rules, { epoch: 2, seed: 1, startedAt: boot })), null);

    // Throwing the newest epoch away: its rows go, and the next one takes its number.
    assert.ok((await bootMind((await epochs.current())!, kit, KIT, boot + MINUTE_MS)).ok);
    assert.equal(await discardEpoch(pool, 2), true);
    assert.equal(await discardEpoch(pool, 2), false);
    assert.equal(await latestEpoch(pool), 1);
    const orphans = await pool.query(
      `SELECT (SELECT COUNT(*) FROM seats WHERE epoch_id NOT IN (SELECT id FROM epochs))
            + (SELECT COUNT(*) FROM owners WHERE epoch_id NOT IN (SELECT id FROM epochs))
            + (SELECT COUNT(*) FROM record WHERE epoch_id NOT IN (SELECT id FROM epochs))
            + (SELECT COUNT(*) FROM orders_log WHERE epoch_id NOT IN (SELECT id FROM epochs)) AS n`,
    );
    assert.equal(Number(orphans.rows[0].n), 0);
    assert.deepEqual((await listSeats(pool, 1)).map((s) => s.account), [seat.account], "epoch 1 keeps its seat");
    assert.ok(currentMind(await (await epochs.epoch(1))!.read(), "kit"), "and its minds");
    await createEpoch(pool, newGame(rules, { epoch: 2, seed: 5, startedAt: boot + HOUR_MS }));
    // The same Epochs, still running: it opens the new epoch 2, not the discarded one.
    const fresh = await (await epochs.current())!.read();
    assert.equal(fresh.start.seed, 5);
    assert.equal(currentMind(fresh, "kit"), undefined);
  } finally {
    await pool.end();
  }
}

async function main() {
  await memory();
  await postgres();
}

main().then(
  () => console.log("lifecycle: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
