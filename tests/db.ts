import "../src/dotenv.js";
import type { Pool } from "pg";
import { createPool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

// Shared setup for the suites that need Postgres. Each drops and recreates
// the mind schema in TEST_DATABASE_URL, so this refuses to touch
// DATABASE_URL, and the suite skips when TEST_DATABASE_URL isn't set.

export function testDatabaseUrl(suite: string): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) {
    console.log(`${suite}: skipped (TEST_DATABASE_URL not set)`);
    process.exit(0);
  }
  if (url === process.env["DATABASE_URL"]) {
    console.error("TEST_DATABASE_URL must not be the same as DATABASE_URL: the tests drop the mind schema.");
    process.exit(1);
  }
  return url;
}

/** A pool on the test database, its mind schema freshly migrated. */
export async function freshDatabase(suite: string): Promise<{ url: string; pool: Pool }> {
  const url = testDatabaseUrl(suite);
  const pool = createPool(url);
  await pool.query("DROP SCHEMA IF EXISTS mind CASCADE");
  await migrate(pool, () => {});
  return { url, pool };
}
