import type { Pool, PoolClient } from "pg";
import { withTransaction, type Db } from "../db/index.js";
import type { GameEvent } from "../engine/record.js";
import type { Rules } from "../engine/rules.js";
import type { World } from "../engine/state.js";
import type { Game, LogEntry, Owner, Write } from "../game/state.js";
import { applyWrite, type WorldStore } from "./store.js";

// A game in Postgres: one mind.epochs row holding the rules and the world,
// and rows for the orders log, the Record and the owners, which are only
// ever appended (migrations/001_mind_schema.sql).
//
// Writes from every process are serialized by locking the epoch's row
// (SELECT … FOR UPDATE) for the write's transaction. Inside it, the store
// catches up on anything another process wrote, runs the game layer's
// function against the latest game, and saves the write: the world rewritten,
// the rest inserted.
//
// The store keeps the game it last read in memory and catches up by
// fetching only the rows past it, so a read is one small query when nothing
// changed. Calls on one store run one at a time, as the memory store's do, so
// catching up never interleaves.

/** How far the cached game has read: the epoch's write count and the last row of each table. */
interface Cursor {
  writes: number;
  logId: number;
  seq: number;
  ownerId: number;
}

const json = (value: unknown) => JSON.stringify(value);
const date = (ms: number) => new Date(ms);

export class PostgresStore implements WorldStore {
  private queue: Promise<unknown> = Promise.resolve();
  private game: Game | null = null;
  private cursor: Cursor = { writes: -1, logId: 0, seq: 0, ownerId: 0 };

  /** Use openEpoch or createEpoch, which check the epoch exists. */
  constructor(
    private readonly pool: Pool,
    /** The epoch's mind.epochs id (not its number). */
    readonly epochId: number,
  ) {}

  read(): Promise<Game> {
    return this.enqueue(() => this.catchUp(this.pool));
  }

  update<T>(fn: (game: Game) => { write: Write | null; value: T }): Promise<T> {
    return this.enqueue(async () => {
      const { write, value, cursor } = await withTransaction(this.pool, async (client) => {
        await client.query("SELECT 1 FROM epochs WHERE id = $1 FOR UPDATE", [this.epochId]);
        const game = await this.catchUp(client);
        const { write, value } = fn(game);
        const cursor = write ? await this.save(client, write) : null;
        return { write, value, cursor };
      });
      // Committed: the cached game takes the write as the database did.
      if (write && cursor) {
        applyWrite(this.game!, write);
        this.cursor = cursor;
      }
      return value;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    // A failed call doesn't block the ones queued after it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Brings the cached game up to the database's, fetching only what's new. */
  private async catchUp(db: Db): Promise<Game> {
    const { rows } = await db.query<{ writes: number }>("SELECT writes FROM epochs WHERE id = $1", [this.epochId]);
    const writes = rows[0]?.writes;
    if (writes === undefined) throw new Error(`epoch ${this.epochId} doesn't exist`);
    if (this.game && writes === this.cursor.writes) return this.game;

    const head = await db.query<{ number: number; seed: number; started_at: Date; rules: Rules; world: World }>(
      `SELECT number, seed, started_at, ${this.game ? "NULL AS rules" : "rules"}, world FROM epochs WHERE id = $1`,
      [this.epochId],
    );
    const epoch = head.rows[0]!;
    const log = await db.query<{ id: number; entry: LogEntry }>(
      "SELECT id, entry FROM orders_log WHERE epoch_id = $1 AND id > $2 ORDER BY id",
      [this.epochId, this.cursor.logId],
    );
    const record = await db.query<{ seq: number; event: GameEvent }>(
      "SELECT seq, event FROM record WHERE epoch_id = $1 AND seq > $2 ORDER BY seq",
      [this.epochId, this.cursor.seq],
    );
    const owners = await db.query<{ id: number; account: string; domain: number }>(
      "SELECT id, account, domain FROM owners WHERE epoch_id = $1 AND id > $2 ORDER BY id",
      [this.epochId, this.cursor.ownerId],
    );

    this.game ??= {
      rules: epoch.rules,
      start: { epoch: epoch.number, seed: epoch.seed, startedAt: epoch.started_at.getTime() },
      world: epoch.world,
      owners: [],
      log: [],
      record: [],
    };
    this.game.world = epoch.world;
    this.game.log.push(...log.rows.map((r) => r.entry));
    this.game.record.push(...record.rows.map((r) => r.event));
    this.game.owners.push(...owners.rows.map((r) => ({ account: r.account, domain: r.domain })));
    this.cursor = {
      writes,
      logId: log.rows.at(-1)?.id ?? this.cursor.logId,
      seq: record.rows.at(-1)?.seq ?? this.cursor.seq,
      ownerId: owners.rows.at(-1)?.id ?? this.cursor.ownerId,
    };
    return this.game;
  }

  /** Saves a write inside the locked transaction. Returns where the cache will stand once it commits. */
  private async save(client: PoolClient, write: Write): Promise<Cursor> {
    const { rows } = await client.query<{ writes: number }>(
      "UPDATE epochs SET world = $2, writes = writes + 1, updated_at = NOW() WHERE id = $1 RETURNING writes",
      [this.epochId, json(write.world)],
    );
    const log = await insertLog(client, this.epochId, [write.entry]);
    await insertRecord(client, this.epochId, write.events);
    const owners = write.owner ? await insertOwners(client, this.epochId, [write.owner]) : [];
    return {
      writes: rows[0]!.writes,
      logId: log.at(-1)!,
      seq: write.events.at(-1)?.seq ?? this.cursor.seq,
      ownerId: owners.at(-1) ?? this.cursor.ownerId,
    };
  }
}

async function insertLog(db: Db, epochId: number, entries: LogEntry[]): Promise<number[]> {
  const ids: number[] = [];
  for (const e of entries) {
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO orders_log (epoch_id, at, account, kind, seq, entry) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [epochId, date(e.at), e.account, e.kind, e.seq, json(e)],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

async function insertRecord(db: Db, epochId: number, events: GameEvent[]): Promise<void> {
  if (events.length === 0) return;
  // One statement for the lot: a write can carry a day's settled timers.
  await db.query(
    `INSERT INTO record (epoch_id, seq, at, type, public, event)
     SELECT $1, e.seq, to_timestamp(e.at / 1000.0), e.type, e.public, e.event
       FROM json_to_recordset($2::json) AS e(seq bigint, at double precision, type text, public boolean, event json)`,
    [epochId, json(events.map((e) => ({ seq: e.seq, at: e.at, type: e.type, public: e.public, event: e })))],
  );
}

async function insertOwners(db: Db, epochId: number, owners: Owner[]): Promise<number[]> {
  const ids: number[] = [];
  for (const o of owners) {
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO owners (epoch_id, account, domain) VALUES ($1, $2, $3) RETURNING id",
      [epochId, o.account, o.domain],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

/**
 * Stores a new game (usually newGame's: the legacy systems booted, nothing
 * logged) as an epoch. Refuses an epoch number already in the database.
 */
export async function createEpoch(pool: Pool, game: Game): Promise<PostgresStore> {
  const id = await withTransaction(pool, (client) => insertEpoch(client, game));
  if (id === null) throw new Error(`epoch ${game.start.epoch} already exists`);
  return new PostgresStore(pool, id);
}

/**
 * The reboot's write: stores the next epoch and seats in it the scripted
 * players seated in the one before, in one transaction. Null when the
 * epoch exists already (another process rebooted first): nothing changes.
 */
export async function createNextEpoch(pool: Pool, game: Game): Promise<PostgresStore | null> {
  const id = await withTransaction(pool, async (client) => {
    const id = await insertEpoch(client, game);
    if (id === null) return null;
    await client.query(
      `INSERT INTO seats (epoch_id, account, strategy, seed, boot)
       SELECT $1, s.account, s.strategy, s.seed, s.boot FROM seats s JOIN epochs e ON e.id = s.epoch_id
        WHERE e.number = $2 ORDER BY s.id`,
      [id, game.start.epoch - 1],
    );
    return id;
  });
  return id === null ? null : new PostgresStore(pool, id);
}

async function insertEpoch(client: PoolClient, game: Game): Promise<number | null> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO epochs (number, seed, started_at, rules, world, writes)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (number) DO NOTHING RETURNING id`,
    [game.start.epoch, game.start.seed, date(game.start.startedAt), json(game.rules), json(game.world), game.log.length],
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;
  await insertLog(client, id, game.log);
  await insertRecord(client, id, game.record);
  await insertOwners(client, id, game.owners);
  return id;
}

/**
 * Throws an epoch away: its seats, owners, Record, orders log and row. For
 * test epochs (`npm run epoch -- discard`); a played epoch belongs in the
 * Archive. Returns whether there was one.
 */
export async function discardEpoch(pool: Pool, number: number): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: number }>("SELECT id FROM epochs WHERE number = $1 FOR UPDATE", [number]);
    const id = rows[0]?.id;
    if (id === undefined) return false;
    for (const table of ["seats", "owners", "record", "orders_log"]) await client.query(`DELETE FROM ${table} WHERE epoch_id = $1`, [id]);
    await client.query("DELETE FROM epochs WHERE id = $1", [id]);
    return true;
  });
}

/** The store for an epoch by its number, or null if there's no such epoch. */
export async function openEpoch(pool: Pool, number: number): Promise<PostgresStore | null> {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM epochs WHERE number = $1", [number]);
  return rows[0] ? new PostgresStore(pool, rows[0].id) : null;
}

/** The newest epoch's number, or null if there's none yet. */
export async function latestEpoch(pool: Pool): Promise<number | null> {
  const { rows } = await pool.query<{ number: number }>("SELECT MAX(number) AS number FROM epochs");
  return rows[0]?.number ?? null;
}

/** Every epoch's number, newest first. */
export async function epochNumbers(pool: Pool): Promise<number[]> {
  const { rows } = await pool.query<{ number: number }>("SELECT number FROM epochs ORDER BY number DESC");
  return rows.map((r) => r.number);
}

/** A scripted player seated in an epoch. `strategy` and `boot` are checked by whoever reads them. */
export interface SeatRecord {
  account: string;
  strategy: string;
  seed: number;
  boot: unknown;
}

/** Seats a scripted player in an epoch. Refuses an account already seated there. */
export async function addSeat(pool: Pool, epoch: number, seat: SeatRecord): Promise<void> {
  const { rowCount } = await pool.query(
    `INSERT INTO seats (epoch_id, account, strategy, seed, boot)
     SELECT id, $2, $3, $4, $5 FROM epochs WHERE number = $1
     ON CONFLICT (epoch_id, account) DO NOTHING`,
    [epoch, seat.account, seat.strategy, seat.seed, JSON.stringify(seat.boot)],
  );
  if (!rowCount) throw new Error(`Couldn't seat ${seat.account}: no epoch ${epoch}, or it's seated already.`);
}

/** The scripted players seated in an epoch, oldest first. */
export async function listSeats(pool: Pool, epoch: number): Promise<SeatRecord[]> {
  const { rows } = await pool.query<{ account: string; strategy: string; seed: string; boot: unknown }>(
    `SELECT s.account, s.strategy, s.seed, s.boot FROM seats s JOIN epochs e ON e.id = s.epoch_id
      WHERE e.number = $1 ORDER BY s.id`,
    [epoch],
  );
  return rows.map((r) => ({ account: r.account, strategy: r.strategy, seed: Number(r.seed), boot: r.boot }));
}
