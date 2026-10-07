import { randomBytes } from "node:crypto";
import type { Logins } from "../src/web/app.js";

// A stand-in for src/auth/logins.ts in the web suites: accounts and
// passwords in memory, sessions as plain tokens. The real one, against
// Postgres, is tests/postgres.test.ts's.

export function memoryLogins(passwords: Record<string, string>): Logins & { sessions: Map<string, string> } {
  const sessions = new Map<string, string>();
  return {
    sessions,
    lifetimeSeconds: 3600,
    async logIn(name, password) {
      if (passwords[name] === undefined || passwords[name] !== password) return { ok: false, error: "That name and password don't match an account." };
      const token = randomBytes(16).toString("hex");
      sessions.set(token, name);
      return { ok: true, token };
    },
    async session(token) {
      const account = sessions.get(token);
      return account === undefined ? null : { account };
    },
    async logOut(token) {
      sessions.delete(token);
    },
    async changePassword(token, current, next) {
      const account = sessions.get(token);
      if (account === undefined) return { ok: false, error: "You're not logged in." };
      if (passwords[account] !== current) return { ok: false, error: "Your current password isn't right." };
      passwords[account] = next;
      for (const [t, a] of sessions) if (a === account && t !== token) sessions.delete(t);
      return { ok: true };
    },
  };
}

/** The site's origin in tests: form posts carry it, as a browser's would. */
export const ORIGIN = "http://127.0.0.1:3111";

/** Logs in through the form; the session cookie, as a browser would send it back. */
export async function logIn(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, name: string, password: string): Promise<string> {
  const res = await app.request("/login", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name, password }).toString(),
  });
  if (res.status !== 303) throw new Error(`login as ${name} answered ${res.status}`);
  const cookie = /mind_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (!cookie) throw new Error("no session cookie");
  return `mind_session=${cookie}`;
}
