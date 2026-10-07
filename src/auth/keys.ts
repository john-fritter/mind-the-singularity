import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import type { Identity } from "../game/state.js";

// Accounts and their API keys: how an agent proves who it is to the MCP
// server, as Fritter Board's bot tokens do. A key maps to one account, and
// the game layer allows an account one live mind, so a key plays one domain.
// One live key per account; issuing a new one revokes the old. Only the
// key's SHA-256 is stored: keys are long and random, so a slow hash would
// add nothing but time on every call.

const KEY_BYTES = 32;
/** Keys carry a recognizable prefix, so one pasted into the wrong place is easy to spot. */
export const KEY_PREFIX = "mind_";

/** Letters, digits, `_`, `.` and `-`, starting with a letter or digit; never a colon, which legacy accounts use. */
export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Account {
  id: number;
  name: string;
  createdAt: Date;
  /** Whether it may see the admin view, logged in on the web. */
  admin: boolean;
  /** Whether it has a live key, and when that key was last used. */
  keyLive: boolean;
  keyLastUsedAt: Date | null;
}

/** Creates an account. Throws on a bad name or one taken (in any case). */
export async function createAccount(db: Db, name: string): Promise<number> {
  if (!ACCOUNT_NAME.test(name)) throw new Error(`"${name}" isn't a valid account name: letters, digits, _ . - only, at most 80`);
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO accounts (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id",
    [name],
  );
  if (!rows[0]) throw new Error(`An account named "${name}" already exists.`);
  return rows[0].id;
}

/** An account by name, in any case, or null. */
export async function findAccount(db: Db, name: string): Promise<Account | null> {
  return (await listAccounts(db, name))[0] ?? null;
}

/** Every account, oldest first, or the one named. */
export async function listAccounts(db: Db, name?: string): Promise<Account[]> {
  const { rows } = await db.query<{ id: number; name: string; created_at: Date; admin: boolean; key_id: number | null; last_used_at: Date | null }>(
    `SELECT a.id, a.name, a.created_at, a.admin, k.id AS key_id, k.last_used_at
       FROM accounts a
       LEFT JOIN api_keys k ON k.account_id = a.id AND k.revoked_at IS NULL
      WHERE $1::text IS NULL OR LOWER(a.name) = LOWER($1)
      ORDER BY a.id`,
    [name ?? null],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, admin: r.admin, keyLive: r.key_id !== null, keyLastUsedAt: r.last_used_at }));
}

/**
 * Issues a new key for an account, revoking any it had. Returns the key
 * itself, once; it's never stored in the clear. Run it in a transaction, so
 * the revoke and the insert land together.
 */
export async function issueKey(db: Db, accountId: number): Promise<string> {
  const key = KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
  await db.query("UPDATE api_keys SET revoked_at = NOW() WHERE account_id = $1 AND revoked_at IS NULL", [accountId]);
  await db.query("INSERT INTO api_keys (account_id, key_hash) VALUES ($1, $2)", [accountId, sha256(key)]);
  return key;
}

/** Revokes an account's key. Returns how many were live (0 or 1). */
export async function revokeKeys(db: Db, accountId: number): Promise<number> {
  const { rowCount } = await db.query("UPDATE api_keys SET revoked_at = NOW() WHERE account_id = $1 AND revoked_at IS NULL", [
    accountId,
  ]);
  return rowCount ?? 0;
}

/** Grants or removes an account's admin flag. */
export async function setAdmin(db: Db, accountId: number, admin: boolean): Promise<void> {
  await db.query("UPDATE accounts SET admin = $2 WHERE id = $1", [accountId, admin]);
}

/**
 * The identity a key acts as, or null for a key that's unknown, revoked or
 * malformed. Records when the key was last used. Never an admin: the
 * admin view is the web's alone.
 */
export async function identityForKey(db: Db, key: string): Promise<Identity | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const { rows } = await db.query<{ name: string }>(
    `UPDATE api_keys k SET last_used_at = NOW()
       FROM accounts a
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND a.id = k.account_id
     RETURNING a.name`,
    [sha256(key)],
  );
  return rows[0] ? { account: rows[0].name } : null;
}
