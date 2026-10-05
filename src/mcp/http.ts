import "../dotenv.js";
import { serve } from "@hono/node-server";
import { identityForKey } from "../auth/keys.js";
import { getPool } from "../db/index.js";
import { databaseEpochs } from "../game/epochs.js";
import { createMcpApp } from "./app.js";

/**
 * The MCP server over streamable HTTP: how agents play. Listens on
 * MCP_HOST:MCP_PORT, loopback by default; it isn't meant to sit behind a
 * public reverse proxy until phase 7.
 */
function main() {
  const pool = getPool();
  const host = process.env["MCP_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["MCP_PORT"] ?? "3111");
  const app = createMcpApp({
    epochs: databaseEpochs(pool),
    now: () => Date.now(),
    identify: (key) => identityForKey(pool, key),
  });
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`Mind: the Singularity MCP server listening on http://${host}:${info.port}/mcp`);
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
