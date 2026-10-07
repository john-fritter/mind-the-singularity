import "./dotenv.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { identityForKey } from "./auth/keys.js";
import { databaseLogins } from "./auth/logins.js";
import { loadPlayers, loadSite } from "./config.js";
import { getPool } from "./db/index.js";
import { ARCHITECTURES } from "./engine/architectures.js";
import { databaseEpochs } from "./game/epochs.js";
import { ServerClock, type SeatRow } from "./players/clock.js";
import { STRATEGIES } from "./players/settings.js";
import { listSeats, type SeatRecord } from "./store/postgres.js";

/**
 * The game's one process: the web view and the MCP server at /mcp. Listens
 * on HOST:PORT (MCP_HOST and MCP_PORT still work), loopback by default; a
 * reverse proxy puts the site in front of the public in Phase 6, and /mcp
 * stays for invited agents only until phase 7. PUBLIC_URL is the address
 * people reach it at: form posts must come from it.
 *
 * It also keeps the server's clock: every clock.every_seconds (site.yaml)
 * it wakes the legacy systems and seated scripted players that are due.
 */

/** A seat as the database keeps it, if it's one this server can play. */
function seatRow(r: SeatRecord): SeatRow | null {
  const boot = r.boot as SeatRow["boot"];
  const strategies: string[] = [...STRATEGIES, "random"];
  if (!strategies.includes(r.strategy) || !(ARCHITECTURES as readonly string[]).includes(boot?.architecture)) return null;
  return { account: r.account, strategy: r.strategy as SeatRow["strategy"], seed: r.seed, boot };
}

function main() {
  const pool = getPool();
  const site = loadSite();
  const host = process.env["HOST"] ?? process.env["MCP_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["PORT"] ?? process.env["MCP_PORT"] ?? "3111");
  const origin = new URL(process.env["PUBLIC_URL"] ?? `http://${host}:${port}`).origin;
  const epochs = databaseEpochs(pool);
  const logins = databaseLogins(pool, site);
  const app = createApp({
    epochs,
    now: () => Date.now(),
    identify: (key) => identityForKey(pool, key),
    logins,
    origin,
  });
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`Mind: the Singularity on http://${host}:${info.port}/ (agents: /mcp; people log in at ${origin}/login)`);
  });

  const clock = new ServerClock(
    {
      current: () => epochs.current(),
      seats: async (epoch) => (await listSeats(pool, epoch)).map(seatRow).filter((s) => s !== null),
      settings: loadPlayers(),
    },
    Date.now(),
  );
  const timer = setInterval(() => {
    clock.pass(Date.now()).then(
      (logs) => {
        for (const l of logs) if (l.error) console.error(`${l.account}'s wake was refused: ${l.error}`);
      },
      (err) => console.error("The clock's pass failed:", err),
    );
  }, site.clock.every_seconds * 1000);

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
