import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import type { Site } from "../config.js";
import type { Db } from "../db/index.js";
import type { Identity } from "../game/state.js";
import { ACCOUNT_NAME, findAccount, sha256 } from "./keys.js";
import { LoginLimiter } from "./login-limiter.js";

// How a person proves who they are to the web view, as on Fritter Board: a
// password (argon2id, the library's defaults), then a session whose token
// lives in an HttpOnly cookie, of which only the SHA-256 is stored.
// Changing a password ends the account's other sessions. The account is
// the same one an API key belongs to: either way it plays one mind.

const SESSION_BYTES = 32;
const TEMPORARY_PASSWORD_BYTES = 15;

export type LoginOutcome = { ok: true; token: string } | { ok: false; error: string };

/** What the web view is given to log people in (src/web/app.tsx's Logins). */
export interface Logins {
  logIn(name: string, password: string): Promise<LoginOutcome>;
  session(token: string): Promise<Identity | null>;
  logOut(token: string): Promise<void>;
  changePassword(token: string, current: string, next: string): Promise<{ ok: true } | { ok: false; error: string }>;
  lifetimeSeconds: number;
}

/** Why a password won't do, or null. Keys: login.password_min, login.password_max */
export function passwordProblem(site: Site, password: string): string | null {
  if (password.length < site.login.password_min) return `A password needs at least ${site.login.password_min} characters.`;
  if (password.length > site.login.password_max) return `A password may have at most ${site.login.password_max} characters.`;
  return null;
}

export async function setPassword(db: Db, accountId: number, password: string): Promise<void> {
  await db.query("UPDATE accounts SET password_hash = $2 WHERE id = $1", [accountId, await hash(password)]);
}

/** A random password to hand someone once, for them to change at Settings. */
export const temporaryPassword = () => randomBytes(TEMPORARY_PASSWORD_BYTES).toString("base64url");

/** Ends every session of an account but `keep` (a token's hash). */
export async function endSessions(db: Db, accountId: number, keep: string | null = null): Promise<void> {
  await db.query("DELETE FROM sessions WHERE account_id = $1 AND ($2::text IS NULL OR id <> $2)", [accountId, keep]);
}

async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Logins against the accounts in the database. Keys: sessions.*, login.* */
export function databaseLogins(db: Db, site: Site): Logins {
  const limiter = new LoginLimiter(site.login.max_failures, site.login.window_minutes * 60_000);

  async function sessionRow(token: string) {
    const { rows } = await db.query<{ account_id: string; name: string; admin: boolean; touch: boolean }>(
      `SELECT s.account_id, a.name, a.admin, (s.last_seen_at < NOW() - $2::float8 * INTERVAL '1 second') AS touch
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.id = $1 AND s.expires_at > NOW()`,
      [sha256(token), site.sessions.touch_interval_seconds],
    );
    return rows[0] ?? null;
  }

  return {
    lifetimeSeconds: site.sessions.lifetime_days * 24 * 60 * 60,

    async logIn(name, password) {
      const refused = { ok: false as const, error: "That name and password don't match an account." };
      if (limiter.isBlocked(name)) return { ok: false, error: "Too many failed attempts for that name. Try again later." };
      const account = ACCOUNT_NAME.test(name) ? await findAccount(db, name) : null;
      const { rows } = account ? await db.query<{ password_hash: string | null }>("SELECT password_hash FROM accounts WHERE id = $1", [account.id]) : { rows: [] };
      const stored = rows[0]?.password_hash ?? null;
      if (!account || stored === null || !(await verifyPassword(stored, password))) {
        limiter.recordFailure(name);
        return refused;
      }
      limiter.recordSuccess(name);
      const token = randomBytes(SESSION_BYTES).toString("base64url");
      await db.query(
        `INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, NOW() + $3::float8 * INTERVAL '1 day')`,
        [sha256(token), account.id, site.sessions.lifetime_days],
      );
      return { ok: true, token };
    },

    async session(token) {
      const row = await sessionRow(token);
      if (!row) return null;
      if (row.touch) await db.query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [sha256(token)]);
      // The admin flag is read on every request, so granting or removing it takes effect at once.
      return row.admin ? { account: row.name, admin: true } : { account: row.name };
    },

    async logOut(token) {
      await db.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
    },

    async changePassword(token, current, next) {
      const row = await sessionRow(token);
      if (!row) return { ok: false, error: "You're not logged in." };
      const { rows } = await db.query<{ password_hash: string | null }>("SELECT password_hash FROM accounts WHERE id = $1", [row.account_id]);
      if (!(await verifyPassword(rows[0]?.password_hash ?? "", current))) return { ok: false, error: "Your current password isn't right." };
      const problem = passwordProblem(site, next);
      if (problem) return { ok: false, error: problem };
      await setPassword(db, Number(row.account_id), next);
      await endSessions(db, Number(row.account_id), sha256(token));
      return { ok: true };
    },
  };
}
