/**
 * Epochs in DATABASE_URL.
 *
 * Usage:
 *   npm run epoch -- new [--seed N] [--days N]
 *                                     start the next epoch now, with its legacy systems,
 *                                     once the last one has ended; --days makes this one
 *                                     epoch that many days long instead of epoch.length_days
 *   npm run epoch -- show [--epoch N] the newest epoch (or epoch N) at a glance
 *   npm run epoch -- add STRATEGY [DESIGNATION] [--arch A]
 *                                     seat a scripted player in the newest epoch;
 *                                     `npm start` boots it on its next pass and
 *                                     wakes it on the server's clock
 *   npm run epoch -- seats            the scripted players seated in the newest epoch
 *   npm run epoch -- discard N --yes N
 *                                     throw the newest epoch away, a test one: its world,
 *                                     Record, orders log and seats; the next epoch takes
 *                                     its number. Stop `npm start` first.
 *
 * A new epoch plays by config/rules.yaml as it is now, to its end. After it
 * ends, `npm start` boots the next one itself once epoch.downtime_hours
 * have passed (src/game/lifecycle.ts), with the same scripted players.
 */

import "../src/dotenv.js";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { epochOfDays, loadRules } from "../src/config.js";
import { DAY_MS } from "../src/engine/cycles.js";
import { getPool } from "../src/db/index.js";
import { newGame } from "../src/game/game.js";
import { ARCHITECTURES, type Architecture } from "../src/engine/architectures.js";
import { addSeat, createEpoch, discardEpoch, latestEpoch, listSeats, openEpoch } from "../src/store/postgres.js";
import { STRATEGIES } from "../src/players/settings.js";

const USAGE = `Usage:
  npm run epoch -- new [--seed N] [--days N]
  npm run epoch -- show [--epoch N]
  npm run epoch -- add STRATEGY [DESIGNATION] [--arch ARCHITECTURE]
  npm run epoch -- seats
  npm run epoch -- discard N --yes N`;

/** Seeds are drawn below 2^31, so they fit any integer column and the RNG's seed. */
const SEED_LIMIT = 2 ** 31;

async function run(): Promise<string> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { seed: { type: "string" }, days: { type: "string" }, epoch: { type: "string" }, arch: { type: "string" }, yes: { type: "string" } },
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
    const rules = values.days === undefined ? loadRules() : epochOfDays(loadRules(), Number(values.days));
    await createEpoch(pool, newGame(rules, { epoch, seed, startedAt: now }));
    return `Epoch ${epoch} started at ${new Date(now).toISOString()}, seed ${seed}, ${rules.epoch.length_days} days long.`;
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
  if (positionals[0] === "discard") {
    const number = Number(positionals[1]);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(USAGE);
    // Only the newest, so the Archive never has a gap.
    if (number !== latest) throw new Error(latest === null ? "No epochs yet." : `Only the newest epoch (${latest}) can be thrown away.`);
    // Not undoable, so the number is typed twice.
    if (values.yes !== String(number)) throw new Error(`This deletes epoch ${number} for good. To go ahead: npm run epoch -- discard ${number} --yes ${number}`);
    if (!(await discardEpoch(pool, number))) throw new Error(`No epoch ${number}.`);
    const now = await latestEpoch(pool);
    return `Epoch ${number} is gone. ${now === null ? "No epochs left: npm run epoch -- new" : `The newest is epoch ${now}.`}`;
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
