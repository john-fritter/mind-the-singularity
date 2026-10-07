import "./dotenv.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { identityForKey } from "./auth/keys.js";
import { getPool } from "./db/index.js";
import { databaseEpochs } from "./game/epochs.js";

/**
 * The game's one process: the web view and the MCP server at /mcp. Listens
 * on HOST:PORT (MCP_HOST and MCP_PORT still work), loopback by default; a
 * reverse proxy puts the site in front of the public in Phase 6, and /mcp
 * stays for invited agents only until phase 7.
 */
function main() {
  const pool = getPool();
  const host = process.env["HOST"] ?? process.env["MCP_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["PORT"] ?? process.env["MCP_PORT"] ?? "3111");
  const app = createApp({
    epochs: databaseEpochs(pool),
    now: () => Date.now(),
    identify: (key) => identityForKey(pool, key),
  });
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`Mind: the Singularity on http://${host}:${info.port}/ (agents: /mcp)`);
  });

  const shutdown = () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
