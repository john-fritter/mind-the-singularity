import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createAccount, findAccount, identityForKey, issueKey, KEY_PREFIX, listAccounts, revokeKeys, sha256 } from "../src/auth/keys.js";
import { loadPlayers, loadRules } from "../src/config.js";
import { ARCHITECTURES } from "../src/engine/architectures.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { createPool, withTransaction } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief } from "../src/game/read.js";
import { replay } from "../src/game/replay.js";
import type { Game, Write } from "../src/game/state.js";
import { drive, legacySeats, scriptedSeat, type Seat } from "../src/players/drive.js";
import { STRATEGIES } from "../src/players/settings.js";
import { MemoryStore } from "../src/store/memory.js";
import { createEpoch, latestEpoch, openEpoch, PostgresStore } from "../src/store/postgres.js";
import type { WorldStore } from "../src/store/store.js";
import { freshDatabase } from "./db.js";

// The Postgres store and the accounts (phase 3a): a game kept in the
// database plays exactly as one in memory, from any number of processes,
// and API keys are stored hashed and resolve to their account.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const HALCYON = { designation: "HALCYON", domainName: "Glasswater", architecture: "symbiote" };
const john = { account: "john" };

/** A game as JSON would store it: what a database or a save file holds. */
const asStored = (game: Game) => JSON.parse(JSON.stringify(game)) as Game;

/** Every call goes to the next of the stores in turn, as if each came from another process. */
function alternating(stores: WorldStore[]): WorldStore {
  let i = 0;
  const next = () => stores[i++ % stores.length]!;
  return { read: () => next().read(), update: (fn) => next().update(fn) };
}

function seatsFor(seed: number): Seat[] {
  const settings = loadPlayers();
  const minds = STRATEGIES.map((strategy, i) =>
    scriptedSeat(settings, {
      account: `sim:${i + 1}`,
      strategy,
      seed: seed * 100 + i + 1,
      boot: { designation: `${strategy.toUpperCase()}-${i + 1}`, domainName: "Testbed", architecture: ARCHITECTURES[i % ARCHITECTURES.length]! },
    }),
  );
  return [...legacySeats(rules), ...minds];
}

/** The same scripted epoch in memory and in Postgres ends in the same game, and the stored log replays to it. */
async function sameAsMemory(pool: Pool, url: string) {
  const days = 8;
  const seed = 11;
  const start = { epoch: 1, seed, startedAt: T0 };
  const steps = loadPlayers().steps_per_wake;

  const memory = newGame(rules, start);
  await drive(new MemoryStore(memory), seatsFor(seed), T0 - 1, T0 + days * DAY_MS, steps);

  // Two "processes", each with its own pool and its own store on the epoch.
  const other = createPool(url);
  try {
    const a = await createEpoch(pool, newGame(rules, start));
    const b = new PostgresStore(other, a.epochId);
    await drive(alternating([a, b]), seatsFor(seed), T0 - 1, T0 + days * DAY_MS, steps);
  } finally {
    await other.end();
  }

  const cold = await (await openEpoch(pool, 1))!.read();
  assert.ok(memory.log.length > 100, `a real epoch's worth of writes (${memory.log.length})`);
  assert.ok(memory.record.some((e) => e.type === "battle"), "the minds fought");
  assert.deepEqual(cold, asStored(memory), "Postgres and memory disagree");

  const rebuilt = replay(cold);
  assert.deepEqual(rebuilt.world, cold.world, "the stored log doesn't replay to the stored world");
  assert.deepEqual(rebuilt.record, cold.record);
}

/** Writes from several processes at once land one at a time, each seeing the one before. */
async function oneAtATime(pool: Pool, url: string) {
  const a = await createEpoch(pool, newGame(rules, { epoch: 2, seed: 5, startedAt: T0 }));
  const other = createPool(url);
  try {
    const b = new PostgresStore(other, a.epochId);
    assert.ok((await bootMind(a, john, HALCYON, T0)).ok);
    const monetize = (s: WorldStore) => submitOrders(s, john, [{ do: "monetize" }], T0 + HOUR_MS);
    const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => monetize(i % 2 ? a : b)));
    assert.ok(outs.every((o) => o.ok && o.results[0]!.ok));

    const [ga, gb] = [await a.read(), await b.read()];
    assert.deepEqual(ga, gb, "both processes see the same game");
    assert.equal(ga.log.length, 11);
    assert.equal(currentMind(ga, "john")!.cycles, rules.cycles.cap - 10, "every write saw the one before");
    const seqs = ga.log.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));

    // A write that throws rolls back and doesn't jam either store.
    const before = JSON.stringify(await a.read());
    await assert.rejects(a.update(() => {
      throw new Error("boom");
    }));
    // A write whose save fails (here, a Record sequence number already taken) leaves nothing behind.
    const clash = (game: Game): Write => ({
      world: game.world,
      entry: { kind: "orders", at: T0 + HOUR_MS, account: "john", seq: game.world.seq, domain: 0, orders: [], results: [] },
      events: [game.record[0]!],
    });
    await assert.rejects(b.update((game) => ({ write: clash(game), value: null })));
    assert.equal(JSON.stringify(await a.read()), before);
    assert.equal(JSON.stringify(await b.read()), before, "a failed save doesn't reach the cache");
    assert.ok((await monetize(b)).ok);
    assert.equal((await a.read()).log.length, 12);
  } finally {
    await other.end();
  }
}

/** Reads settle a copy and save nothing. */
async function readsDontWrite(pool: Pool) {
  const store = await createEpoch(pool, newGame(rules, { epoch: 3, seed: 7, startedAt: T0 }));
  assert.ok((await bootMind(store, john, HALCYON, T0)).ok);
  const row = () => pool.query("SELECT world, writes, updated_at FROM epochs WHERE id = $1", [store.epochId]).then((r) => r.rows[0]);
  const before = await row();
  const later = T0 + 20 * DAY_MS;
  const b = await getBrief(store, john, later);
  assert.ok(!("ok" in b) && b.now === later);
  assert.deepEqual(await row(), before);
}

async function epochs(pool: Pool) {
  assert.equal(await latestEpoch(pool), 3);
  assert.equal(await openEpoch(pool, 99), null);
  await assert.rejects(createEpoch(pool, newGame(rules, { epoch: 3, seed: 1, startedAt: T0 })), /already exists/);
  // A new epoch keeps its own rules, seed and start.
  const store = await createEpoch(pool, newGame(rules, { epoch: 4, seed: -12345, startedAt: T0 + 1000 }));
  const game = await (await openEpoch(pool, 4))!.read();
  assert.deepEqual(game.start, { epoch: 4, seed: -12345, startedAt: T0 + 1000 });
  assert.deepEqual(game.rules, rules);
  assert.deepEqual(await store.read(), game);
}

async function keys(pool: Pool) {
  const ada = await createAccount(pool, "Ada");
  await assert.rejects(createAccount(pool, "ada"), /already exists/, "names are unique in any case");
  for (const bad of ["legacy:VESTA", "", " ada", "a b", "-x", "x".repeat(81)]) {
    await assert.rejects(createAccount(pool, bad), /isn't a valid account name/, bad);
  }
  assert.equal((await findAccount(pool, "ADA"))!.id, ada);

  const key = await withTransaction(pool, (c) => issueKey(c, ada));
  assert.ok(key.startsWith(KEY_PREFIX) && key.length > 40);
  assert.deepEqual(await identityForKey(pool, key), { account: "Ada" });
  assert.equal(await identityForKey(pool, key + "x"), null);
  assert.equal(await identityForKey(pool, key.slice(KEY_PREFIX.length)), null);
  assert.equal(await identityForKey(pool, ""), null);
  assert.ok((await findAccount(pool, "ada"))!.keyLastUsedAt, "a used key records when");

  // Only the hash is stored.
  const dump = JSON.stringify((await pool.query("SELECT * FROM api_keys")).rows);
  assert.ok(!dump.includes(key) && !dump.includes(key.slice(KEY_PREFIX.length)));
  assert.ok(dump.includes(sha256(key)));

  // A new key revokes the old one: one live key per account.
  const second = await withTransaction(pool, (c) => issueKey(c, ada));
  assert.equal(await identityForKey(pool, key), null);
  assert.deepEqual(await identityForKey(pool, second), { account: "Ada" });
  await assert.rejects(pool.query("UPDATE api_keys SET revoked_at = NULL WHERE account_id = $1", [ada]), /api_keys_one_live_idx/);

  assert.equal(await revokeKeys(pool, ada), 1);
  assert.equal(await identityForKey(pool, second), null);
  assert.equal(await revokeKeys(pool, ada), 0);
  assert.deepEqual((await listAccounts(pool)).map((a) => [a.name, a.keyLive]), [["Ada", false]]);

  // A key's account plays through the game layer like any other.
  const kit = await createAccount(pool, "kit");
  const kitKey = await withTransaction(pool, (c) => issueKey(c, kit));
  const store = (await openEpoch(pool, 4))!;
  const me = (await identityForKey(pool, kitKey))!;
  assert.ok((await bootMind(store, me, { ...HALCYON, designation: "KIT" }, T0 + 1000)).ok);
  assert.equal(currentMind(await store.read(), "kit")!.designation, "KIT");
}

async function migrations(pool: Pool) {
  assert.deepEqual(await migrate(pool, () => {}), [], "migrating again applies nothing");
  const { rows } = await pool.query<{ table_schema: string }>(
    "SELECT DISTINCT table_schema FROM information_schema.tables WHERE table_name IN ('_migrations', 'epochs', 'accounts', 'api_keys', 'orders_log', 'record', 'owners')",
  );
  assert.deepEqual(rows.map((r) => r.table_schema), ["mind"], "everything is in the mind schema");
}

async function main() {
  const { url, pool } = await freshDatabase("postgres");
  try {
    await sameAsMemory(pool, url);
    await oneAtATime(pool, url);
    await readsDontWrite(pool);
    await epochs(pool);
    await keys(pool);
    await migrations(pool);
  } finally {
    await pool.end();
  }
}

main().then(
  () => console.log("postgres: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
