/**
 * Accounts and their API keys, in DATABASE_URL.
 *
 * Usage:
 *   npm run key -- add <name>      a new account, and its key
 *   npm run key -- rotate <name>   a new key (the old one stops working)
 *   npm run key -- revoke <name>   no key at all
 *   npm run key -- list
 *
 * A key is printed once and never stored in the clear; losing it means
 * issuing a new one. An account plays one mind at a time, so one key plays
 * one domain.
 */

import "../src/dotenv.js";
import { createAccount, findAccount, issueKey, listAccounts, revokeKeys } from "../src/auth/keys.js";
import { getPool, withTransaction } from "../src/db/index.js";

const USAGE = `Usage:
  npm run key -- add <name>
  npm run key -- rotate <name>
  npm run key -- revoke <name>
  npm run key -- list`;

async function run(command: string | undefined, name: string | undefined): Promise<string> {
  const pool = getPool();
  if (command === "list") {
    const accounts = await listAccounts(pool);
    if (accounts.length === 0) return "No accounts yet.";
    return accounts
      .map((a) => `${a.name.padEnd(24)} ${a.keyLive ? `key live, last used ${a.keyLastUsedAt?.toISOString() ?? "never"}` : "no key"}`)
      .join("\n");
  }
  if (!name || !["add", "rotate", "revoke"].includes(command ?? "")) return USAGE;
  if (command === "add") {
    const key = await withTransaction(pool, async (client) => issueKey(client, await createAccount(client, name)));
    return `Account ${name} created. Its key, shown once:\n${key}`;
  }
  const account = await findAccount(pool, name);
  if (!account) throw new Error(`No account named "${name}".`);
  if (command === "rotate") {
    const key = await withTransaction(pool, (client) => issueKey(client, account.id));
    return `A new key for ${account.name}; the old one no longer works. Shown once:\n${key}`;
  }
  const revoked = await revokeKeys(pool, account.id);
  return revoked ? `${account.name}'s key is revoked.` : `${account.name} had no live key.`;
}

async function main() {
  const [command, name] = process.argv.slice(2);
  try {
    console.log(await run(command, name));
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
