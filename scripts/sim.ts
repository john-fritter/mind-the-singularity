/**
 * The simulator: runs many epochs of scripted players and prints the balance
 * report, with phase 2's checks.
 *
 * Usage: npm run sim -- [--epochs 200] [--players builder,raider,turtle,converger,random]
 *                       [--minds 8] [--days 60] [--seed 1] [--jobs N]
 *                       [--rules path/to/rules.yaml] [--settings path/to/players.yaml]
 *                       [--json out.json]
 *
 * Each epoch boots the legacy systems and `--minds` scripted minds drawn from
 * `--players` (each listed strategy once while there's room), with random
 * architectures. Epoch i is seeded `--seed` + i, so a run is reproducible
 * whatever `--jobs` is. `--rules` runs a different rules file, for trying a
 * change to the numbers before making it; `--settings` does the same for the
 * scripted players' knobs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadPlayers, loadRules, parsePlayers, parseRules } from "../src/config.js";
import { STRATEGIES, type StrategyName } from "../src/players/settings.js";
import { buildReport, renderReport } from "../src/sim/report.js";
import { defaultJobs, simulate } from "../src/sim/run.js";

const count = z.coerce.number().int().positive();
const ArgsSchema = z.strictObject({
  epochs: count.default(200),
  players: z
    .string()
    .default([...STRATEGIES, "random"].join(","))
    .transform((s) => s.split(",").map((x) => x.trim()))
    .pipe(z.array(z.enum([...STRATEGIES, "random"])).min(1)),
  minds: count.default(8),
  days: count.default(60),
  seed: z.coerce.number().int().default(1),
  jobs: count.default(defaultJobs()),
  rules: z.string().optional(),
  settings: z.string().optional(),
  json: z.string().optional(),
});

async function main() {
  const { values } = parseArgs({
    options: Object.fromEntries(["epochs", "players", "minds", "days", "seed", "jobs", "rules", "settings", "json"].map((k) => [k, { type: "string" as const }])),
  });
  const parsed = ArgsSchema.safeParse(values);
  if (!parsed.success) {
    console.error(z.prettifyError(parsed.error));
    process.exit(2);
  }
  const a = parsed.data;
  const rules = a.rules ? parseRules(readFileSync(a.rules, "utf-8"), a.rules) : loadRules();
  const settings = a.settings ? parsePlayers(readFileSync(a.settings, "utf-8"), a.settings) : loadPlayers();
  const started = Date.now();
  const results = await simulate(
    { rules, settings, epochs: a.epochs, strategies: a.players as StrategyName[], minds: a.minds, days: a.days, seed: a.seed, jobs: a.jobs },
    (done) => process.stderr.isTTY && process.stderr.write(`\r${done}/${a.epochs} epochs`),
  );
  process.stderr.write(`\r${a.epochs} epochs in ${((Date.now() - started) / 1000).toFixed(0)}s on ${Math.min(a.jobs, a.epochs)} processes\n`);
  const report = buildReport(results);
  console.log(renderReport(report));
  if (a.json) writeFileSync(a.json, JSON.stringify({ args: a, report, epochs: results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
