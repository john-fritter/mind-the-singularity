import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { loadPlayers, loadRules } from "../src/config.js";
import { HOUR_MS, MINUTE_MS } from "../src/engine/cycles.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { replay } from "../src/game/replay.js";
import { ServerClock, type SeatRow } from "../src/players/clock.js";
import { MemoryStore } from "../src/store/memory.js";

// The server's clock (src/players/clock.ts): legacy systems and seated
// scripted players wake on real time, each due seat once a pass, at the
// pass's moment, nothing from before the server started, and the epoch
// still replays from its log.

const rules = loadRules();
const players = loadPlayers();
const T0 = Date.UTC(2026, 9, 5, 12);
const LEGACY_EVERY = rules.legacy.wake_every_hours * HOUR_MS;

async function main() {
  const game = newGame(rules, { epoch: 1, seed: 3, startedAt: T0 });
  const store = new MemoryStore(game);
  const seats: SeatRow[] = [];
  const clock = new ServerClock({ current: async () => store, seats: async () => seats, settings: players }, T0 + 10 * HOUR_MS);
  const legacy = rules.legacy.systems.length;

  // Nothing from before the server started runs: the legacy systems' wakes at 6h are gone.
  let at = T0 + 10 * HOUR_MS + MINUTE_MS;
  assert.deepEqual(await clock.pass(at), []);

  // A scripted player just seated boots on the next pass, with its flavor.
  seats.push({ account: "bot:builder-1", strategy: "builder", seed: 42, boot: { designation: "BUILDER-1", domainName: "The builder domain", architecture: "steward" } });
  at += MINUTE_MS;
  const first = await clock.pass(at);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.account, "bot:builder-1");
  assert.ok(first[0]!.booted && !first[0]!.error, JSON.stringify(first[0]));
  const bot = currentMind(game, "bot:builder-1")!;
  assert.equal(bot.bootedAt, at);
  assert.notEqual(bot.directive + bot.interface + bot.force.name, "", "its flavor was sent");

  // At 12h every legacy system is due once (and the scripted player, if its offset lands there).
  at = T0 + 12 * HOUR_MS + 30_000;
  const second = await clock.pass(at);
  const legacyWakes = second.filter((l) => l.account.startsWith("legacy:"));
  assert.equal(legacyWakes.length, legacy);
  assert.ok(second.every((l) => l.at === at && !l.error), "every wake runs at the pass's moment");

  // A person's orders moved the game's clock past the pass: wakes run at the game's clock instead.
  assert.ok((await bootMind(store, { account: "kit" }, { designation: "KIT", domainName: "Lamplight", architecture: "oracle" }, T0 + 18 * HOUR_MS + 5_000)).ok);
  assert.ok((await submitOrders(store, { account: "kit" }, [{ do: "expand" }], T0 + 18 * HOUR_MS + 9_000)).ok);
  const third = await clock.pass(T0 + 18 * HOUR_MS + 1_000);
  assert.equal(third.filter((l) => l.account.startsWith("legacy:")).length, legacy);
  assert.ok(third.every((l) => l.at === T0 + 18 * HOUR_MS + 9_000 && !l.error), JSON.stringify(third.map((l) => [l.account, l.at, l.error])));

  // A long gap: each seat wakes once, not once per missed wake.
  const fourth = await clock.pass(T0 + 60 * HOUR_MS);
  assert.equal(fourth.filter((l) => l.account.startsWith("legacy:")).length, legacy);
  assert.equal(new Set(fourth.map((l) => l.account)).size, fourth.length);
  // A second pass at the same moment has nothing due.
  assert.deepEqual(await clock.pass(T0 + 60 * HOUR_MS), []);

  // The epoch still rebuilds from its log.
  const rebuilt = replay(game);
  assert.ok(isDeepStrictEqual(rebuilt.world, game.world) && isDeepStrictEqual(rebuilt.record, game.record), "the epoch doesn't replay");

  // No epoch, nothing to do; an epoch that started after the server gets its first wakes.
  const none = new ServerClock({ current: async () => null, seats: async () => [], settings: players }, T0);
  assert.deepEqual(await none.pass(T0 + HOUR_MS), []);
  const later = new MemoryStore(newGame(rules, { epoch: 2, seed: 4, startedAt: T0 + 100 * HOUR_MS }));
  const fresh = new ServerClock({ current: async () => later, seats: async () => [], settings: players }, T0);
  const firstWakes = await fresh.pass(T0 + 100 * HOUR_MS + LEGACY_EVERY);
  assert.equal(firstWakes.length, legacy);
}

main().then(
  () => console.log("clock: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
