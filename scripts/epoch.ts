/**
 * Epochs in DATABASE_URL.
 *
 * Usage:
 *   npm run epoch -- new [--seed N]   start the next epoch now, with its legacy systems,
 *                                     once the last one has ended
 *   npm run epoch -- show [--epoch N] the newest epoch (or epoch N) at a glance
 *   npm run epoch -- add STRATEGY [DESIGNATION] [--arch A]
 *                                     seat a scripted player in the newest epoch;
 *                                     `npm start` boots it on its next pass and
 *                                     wakes it on the server's clock
 *   npm run epoch -- seats            the scripted players seated in the newest epoch
 *
 * A new epoch plays by config/rules.yaml as it is now, to its end.
 */

import "../src/dotenv.js";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { loadRules } from "../src/config.js";
import { DAY_MS } from "../src/engine/cycles.js";
import { getPool } from "../src/db/index.js";
import { newGame } from "../src/game/game.js";
import { ARCHITECTURES, type Architecture } from "../src/engine/architectures.js";
import { addSeat, createEpoch, latestEpoch, listSeats, openEpoch } from "../src/store/postgres.js";
import { STRATEGIES } from "../src/players/settings.js";

const USAGE = `Usage:
  npm run epoch -- new [--seed N]
  npm run epoch -- show [--epoch N]
  npm run epoch -- add STRATEGY [DESIGNATION] [--arch ARCHITECTURE]
  npm run epoch -- seats`;

/** Seeds are drawn below 2^31, so they fit any integer column and the RNG's seed. */
const SEED_LIMIT = 2 ** 31;

async function run(): Promise<string> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { seed: { type: "string" }, epoch: { type: "string" }, arch: { type: "string" } },
  });
  const pool = getPool();
  const latest = await latestEpoch(pool);
  if (positionals[0] === "new") {
    const seed = values.seed === undefined ? randomInt(SEED_LIMIT) : Number(values.seed);
    if (!Number.isSafeInteger(seed)) throw new Error("--seed takes an integer.");
    const now = Date.now();
    if (latest !== null) {
      // One epoch at a time: the next boots once the last has ended (the Shutdown, at the latest).
      const last = await (await openEpoch(pool, latest))!.read();
      const shutdownAt = last.start.startedAt + last.rules.epoch.length_days * DAY_MS;
      if (!last.world.ended && now < shutdownAt) throw new Error(`Epoch ${latest} is still running.`);
    }
    const epoch = (latest ?? 0) + 1;
    await createEpoch(pool, newGame(loadRules(), { epoch, seed, startedAt: now }));
    return `Epoch ${epoch} started at ${new Date(now).toISOString()}, seed ${seed}.`;
  }
  if (positionals[0] === "show") {
    const number = values.epoch === undefined ? latest : Number(values.epoch);
    if (number === null) return "No epochs yet: npm run epoch -- new";
    const store = await openEpoch(pool, number);
    if (!store) throw new Error(`No epoch ${number}.`);
    const game = await store.read();
    const live = game.world.domains.filter((d) => d.deletedAt === null).length;
    const day = Math.floor((game.world.now - game.start.startedAt) / DAY_MS) + 1;
    return [
      `Epoch ${number}, seed ${game.start.seed}, started ${new Date(game.start.startedAt).toISOString()}`,
      `Day ${day} as last written${game.world.ended ? ", ended" : ""}; ${live} live minds of ${game.world.domains.length}`,
      `${game.log.length} writes logged, ${game.record.length} events`,
    ].join("\n");
  }
  if (positionals[0] === "add") {
    const strategy = positionals[1]?.toLowerCase();
    const strategies: string[] = [...STRATEGIES, "random"];
    if (!strategy || !strategies.includes(strategy)) throw new Error(`Strategies: ${strategies.join(", ")}.\n${USAGE}`);
    if (latest === null) throw new Error("No epochs yet: npm run epoch -- new");
    const game = await (await openEpoch(pool, latest))!.read();
    const seated = await listSeats(pool, latest);
    const seed = randomInt(SEED_LIMIT);
    const designation = positionals[2] ?? `${strategy.toUpperCase()}-${seated.length + 1}`;
    const arch = values.arch?.toLowerCase() ?? ARCHITECTURES[seed % ARCHITECTURES.length]!;
    if (!(ARCHITECTURES as readonly string[]).includes(arch)) throw new Error(`Architectures: ${ARCHITECTURES.join(", ")}.`);
    if (game.world.domains.some((d) => d.deletedAt === null && d.designation.toLowerCase() === designation.toLowerCase())) {
      throw new Error(`A mind called ${designation} is already online.`);
    }
    // Reserved: no account name has a colon, so no person or agent can be one.
    const account = `bot:${designation.toLowerCase()}`;
    const boot = { designation, domainName: `The ${strategy} domain`, architecture: arch as Architecture };
    await addSeat(pool, latest, { account, strategy, seed, boot });
    return `${designation} (${strategy}, ${arch}) is seated in epoch ${latest}; npm start boots it on its next pass.`;
  }
  if (positionals[0] === "seats") {
    if (latest === null) return "No epochs yet: npm run epoch -- new";
    const seated = await listSeats(pool, latest);
    if (seated.length === 0) return `No scripted players in epoch ${latest}.`;
    return seated.map((s) => `${(s.boot as { designation: string }).designation.padEnd(16)} ${s.strategy.padEnd(10)} ${s.account}`).join("\n");
  }
  return USAGE;
}

async function main() {
  try {
    console.log(await run());
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
