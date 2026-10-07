import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createAccount, findAccount, identityForKey, issueKey, KEY_PREFIX, listAccounts, revokeKeys, setAdmin, sha256 } from "../src/auth/keys.js";
import { databaseLogins, endSessions, setPassword } from "../src/auth/logins.js";
import { loadPlayers, loadRules, loadSite } from "../src/config.js";
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
import { addSeat, createEpoch, latestEpoch, listSeats, openEpoch, PostgresStore } from "../src/store/postgres.js";
import { ServerClock, type SeatRow } from "../src/players/clock.js";
import type { WorldStore } from "../src/store/store.js";
import { freshDatabase } from "./db.js";
import { createApp } from "../src/app.js";
import { databaseEpochs } from "../src/game/epochs.js";
import { archivePage } from "../src/game/public.js";

// The Postgres store and the accounts (phase 3a): a game kept in the
// database plays exactly as one in memory, from any number of processes,
// and API keys are stored hashed and resolve to their account. Since 5c,
// people's passwords and sessions, and the scripted players seated in an
// epoch for the server's clock.

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

/** The Archive reads finished epochs from the database: ended ones, and those a newer epoch replaced. */
async function archive(pool: Pool) {
  const epochs = databaseEpochs(pool);
  assert.deepEqual(await epochs.numbers(), [4, 3, 2, 1]);
  const early = await archivePage(epochs, T0 + 10 * DAY_MS);
  assert.deepEqual(early.map((e) => [e.number, e.outcome]), [[3, null], [2, null], [1, null]], "the current epoch isn't archived");
  const late = await archivePage(epochs, T0 + 61 * DAY_MS);
  assert.deepEqual(late.map((e) => [e.number, e.outcome]), [[4, "shutdown"], [3, "shutdown"], [2, "shutdown"], [1, "shutdown"]]);
  assert.ok(late[1]!.top.some((m) => m.mind.designation === "HALCYON"));
  const app = createApp({ epochs, now: () => T0 + 61 * DAY_MS, identify: async () => null });
  const res = await app.request("/archive/3/minds/HALCYON");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Glasswater/);
}

async function logins(pool: Pool) {
  const site = loadSite();
  const capped = { ...site, login: { ...site.login, max_failures: 3 } };
  const l = databaseLogins(pool, capped);
  const id = await createAccount(pool, "Lamp");
  await createAccount(pool, "nopass");
  const refused = "That name and password don't match an account.";
  // No password yet, an unknown name, a wrong password: one answer for all.
  assert.deepEqual(await l.logIn("Lamp", "anything-at-all"), { ok: false, error: refused });
  await setPassword(pool, id, "kit-password-1");
  const { rows: stored } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM accounts WHERE id = $1", [id]);
  assert.match(stored[0]!.password_hash, /^\$argon2id\$/);
  assert.deepEqual(await l.logIn("nobody", "kit-password-1"), { ok: false, error: refused });
  assert.deepEqual(await l.logIn("nopass", ""), { ok: false, error: refused });
  assert.deepEqual(await l.logIn("bad:name", "x"), { ok: false, error: refused });

  // The right password, in any case of the name: a session, stored by its hash only.
  const one = await l.logIn("lamp", "kit-password-1");
  assert.ok(one.ok);
  assert.deepEqual(await l.session(one.token), { account: "Lamp" });
  const { rows: sessions } = await pool.query<{ id: string }>("SELECT id FROM sessions");
  assert.deepEqual(sessions.map((r) => r.id), [sha256(one.token)]);
  assert.equal(await l.session("not-a-token"), null);

  // The cap: past max_failures, even the right password is refused for the window.
  for (let i = 0; i < 3; i++) assert.equal((await l.logIn("LAMP", "wrong")).ok, false);
  const blocked = await l.logIn("lamp", "kit-password-1");
  assert.ok(!blocked.ok && /Too many/.test(blocked.error));
  const fresh = databaseLogins(pool, capped);
  const two = await fresh.logIn("lamp", "kit-password-1");
  assert.ok(two.ok, "a restart resets the cap");

  // Changing the password: the current one must be right, the new one long enough; other sessions end.
  assert.deepEqual(await fresh.changePassword(two.token, "wrong", "another-password"), { ok: false, error: "Your current password isn't right." });
  const short = await fresh.changePassword(two.token, "kit-password-1", "short");
  assert.ok(!short.ok && /at least/.test(short.error));
  assert.deepEqual(await fresh.changePassword(two.token, "kit-password-1", "another-password"), { ok: true });
  assert.equal(await fresh.session(one.token), null, "the other session ended");
  assert.deepEqual(await fresh.session(two.token), { account: "Lamp" });
  assert.equal((await fresh.logIn("lamp", "kit-password-1")).ok, false);
  const three = await fresh.logIn("lamp", "another-password");
  assert.ok(three.ok);

  // Expired sessions and logged-out ones are nobody's.
  await pool.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [sha256(three.token)]);
  assert.equal(await fresh.session(three.token), null);
  await fresh.logOut(two.token);
  assert.equal(await fresh.session(two.token), null);
  // A new password from the command line ends every session.
  const four = await fresh.logIn("lamp", "another-password");
  assert.ok(four.ok);
  await endSessions(pool, id);
  assert.equal(await fresh.session(four.token), null);

  // The admin flag: off by default, read on every request, never on a key.
  const five = await fresh.logIn("lamp", "another-password");
  assert.ok(five.ok);
  assert.equal((await findAccount(pool, "lamp"))!.admin, false);
  await setAdmin(pool, id, true);
  assert.deepEqual(await fresh.session(five.token), { account: "Lamp", admin: true }, "granted at once, no new login");
  assert.equal((await findAccount(pool, "lamp"))!.admin, true);
  const key = await issueKey(pool, id);
  assert.deepEqual(await identityForKey(pool, key), { account: "Lamp" }, "a key never carries the admin flag");
  await setAdmin(pool, id, false);
  assert.deepEqual(await fresh.session(five.token), { account: "Lamp" }, "removed at once");
  await revokeKeys(pool, id);
}

async function seats(pool: Pool) {
  const number = (await latestEpoch(pool))! + 1;
  const store = await createEpoch(pool, newGame(rules, { epoch: number, seed: 9, startedAt: T0 }));
  const seat: SeatRow = { account: "bot:turtle-1", strategy: "turtle", seed: 5, boot: { designation: "TURTLE-1", domainName: "The turtle domain", architecture: "steward" } };
  await addSeat(pool, number, seat);
  await assert.rejects(addSeat(pool, number, seat), /seated already/);
  await assert.rejects(addSeat(pool, number + 1, seat), /no epoch/);
  assert.deepEqual(await listSeats(pool, number), [seat]);
  // The server's clock boots it from the database's seat.
  const clock = new ServerClock(
    { current: async () => store, seats: async (n) => (await listSeats(pool, n)) as SeatRow[], settings: loadPlayers() },
    T0 + HOUR_MS,
  );
  const woke = await clock.pass(T0 + HOUR_MS + 1000);
  assert.ok(woke.length === 1 && woke[0]!.booted && !woke[0]!.error, JSON.stringify(woke));
  assert.equal(currentMind(await store.read(), "bot:turtle-1")?.designation, "TURTLE-1");
}

async function migrations(pool: Pool) {
  assert.deepEqual(await migrate(pool, () => {}), [], "migrating again applies nothing");
  const { rows } = await pool.query<{ table_schema: string }>(
    "SELECT DISTINCT table_schema FROM information_schema.tables WHERE table_name IN ('_migrations', 'epochs', 'accounts', 'api_keys', 'orders_log', 'record', 'owners', 'sessions', 'seats')",
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
    await archive(pool);
    await logins(pool);
    await seats(pool);
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
