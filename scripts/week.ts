/**
 * The simulated week (phase 3e): one model bot plays against the legacy
 * systems and scripted minds through the real MCP server, on a fake clock.
 *
 * Usage: npm run week -- [--days 7] [--wakes-per-day 8] [--seed 1] [--bot lantern]
 *                        [--opponents builder,raider,turtle,converger]
 *                        [--start 2026-10-05T00:00Z] [--out logs/week] [--resume]
 *
 * Defaults are config/runner.yaml's `week`. Each bot's model key comes from
 * runner.env, as for `npm run runner`. Writes the save, wakes.jsonl and
 * report.md to the out directory; `--resume` continues a run that stopped
 * on a failed model call. Exits non-zero if a brief passes the ceiling or
 * the game doesn't replay.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { z } from "zod";
import { loadPlayers, loadRules } from "../src/config.js";
import { NanoGptModel } from "../src/runner/model.js";
import { loadRunner, readPersona, ROOT } from "../src/runner/settings.js";
import { runWeek } from "../src/week/week.js";

dotenv.config({ path: path.join(ROOT, "runner.env"), quiet: true });

const count = z.coerce.number().int().positive();
const ArgsSchema = z.strictObject({
  days: count.optional(),
  "wakes-per-day": count.optional(),
  seed: z.coerce.number().int().optional(),
  bots: z.string().optional(),
  opponents: z.string().optional(),
  start: z.string().optional(),
  out: z.string().optional(),
  resume: z.boolean().default(false),
});

async function main() {
  const { values } = parseArgs({
    options: {
      ...Object.fromEntries(["days", "wakes-per-day", "seed", "bots", "opponents", "start", "out"].map((k) => [k, { type: "string" as const }])),
      resume: { type: "boolean" as const },
    },
  });
  const parsed = ArgsSchema.safeParse(values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  const a = parsed.data;

  const runner = loadRunner();
  if (!runner.week) throw new Error("config/runner.yaml has no `week` block.");
  const w = runner.week;
  const botNames = a.bots !== undefined ? a.bots.split(",").map((s) => s.trim()) : w.bots;
  const bots = botNames.map((name) => {
    const bot = runner.bots.find((b) => b.name === name);
    if (!bot) throw new Error(`No bot named "${name}" in config/runner.yaml.`);
    return bot;
  });
  const startedAt = a.start !== undefined ? Date.parse(a.start) : Date.UTC(2026, 9, 5);
  if (!Number.isFinite(startedAt)) throw new Error(`--start "${a.start}" isn't a time.`);
  const dir = path.resolve(ROOT, a.out ?? w.out_dir);
  if (!a.resume && existsSync(path.join(dir, "week.json"))) {
    throw new Error(`${dir} already holds a week; use --resume to continue it, or --out for another directory.`);
  }

  const models = new Map(
    bots.map((bot) => {
      const modelKey = process.env[bot.model_key_env];
      if (!modelKey) throw new Error(`${bot.model_key_env} isn't set in runner.env.`);
      const model = new NanoGptModel(modelKey, {
        baseUrl: runner.nanogpt_base_url,
        timeoutSeconds: runner.model_timeout_seconds,
        maxOutputTokens: runner.max_output_tokens,
      });
      return [bot.name, model];
    }),
  );

  const out = await runWeek(
    { model: (bot) => models.get(bot.name)!, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (line) => console.log(line) },
    {
      rules: loadRules(),
      players: loadPlayers(),
      runner,
      bots: bots.map((bot) => ({ bot, persona: readPersona(bot) })),
      dir,
      resume: a.resume,
      options: {
        ...w,
        bots: bots.map((b) => b.name),
        days: a.days ?? w.days,
        wakes_per_day: a["wakes-per-day"] ?? w.wakes_per_day,
        seed: a.seed ?? w.seed,
        opponents: a.opponents !== undefined ? a.opponents.split(",").map((s) => s.trim()) : w.opponents,
        startedAt,
      },
    },
  );
  console.log(`\nReport: ${path.relative(ROOT, path.join(dir, "report.md"))}`);
  for (const p of out.problems) console.error(`PROBLEM: ${p}`);
  if (out.problems.length > 0 || !out.finished) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
