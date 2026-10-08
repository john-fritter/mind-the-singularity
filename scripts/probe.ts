/**
 * The capability probe (phase 6b): which NanoGPT subscription models can
 * play a bot. For each model, the runner's checks (src/runner/probe.ts:
 * reachable, reasoning_effort honored, JSON mode), then two real wakes of
 * Lantern on that model in a throwaway game against scripted opponents,
 * through the real MCP server on a fake clock, as `npm run week` plays.
 *
 * Usage: npm run probe -- [--key-env NANOGPT_KEY] [--bot lantern] [--wakes 2]
 *                         [--effort low] [--out logs/probe] <model> [<model>...]
 *
 * The wakes run at `--effort` (low by default), or with none for a model
 * that refuses the parameter.
 *
 * About 7 model calls a model. Writes report.md (and each model's week
 * under its own directory) to the out directory, and prints the table.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { loadPlayers, loadRules } from "../src/config.js";
import { modelIdProblem, NanoGptModel, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { isReachable, probeChecks, type ProbeChecks } from "../src/runner/probe.js";
import { loadRunner, readPersona, ROOT } from "../src/runner/settings.js";
import { runWeek, type WeekWake } from "../src/week/week.js";

dotenv.config({ path: path.join(ROOT, "runner.env"), quiet: true });

/** Times every call, so the report can say how long a wake's calls took. */
class Timed implements ChatModel {
  ms = 0;
  constructor(private readonly model: ChatModel) {}
  async complete(req: ChatRequest): Promise<ChatResponse> {
    const t = Date.now();
    try {
      return await this.model.complete(req);
    } catch (err) {
      console.log(`  a call to ${req.model} failed after ${((Date.now() - t) / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      this.ms += Date.now() - t;
    }
  }
}

interface GameResult {
  wakes: WeekWake[];
  seconds: number;
  stopped: string | null;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const n = (x: number) => Math.round(x).toLocaleString("en-US");

function orderTally(w: WeekWake): { sent: number; ok: number; refused: string[] } {
  const results = (w.results as { results?: { ok: boolean; do?: string; message?: string }[] } | null)?.results ?? [];
  return { sent: results.length, ok: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).map((r) => `${r.do ?? "?"}: ${r.message ?? ""}`) };
}

function row(c: ProbeChecks, g: GameResult | null, wanted: number): string {
  if (!g) return `| \`${c.model}\` | ${cell(c.reachable)} | ${cell(c.reasoning)} | ${cell(c.json)} | - | - | - | - | - |`;
  const done = g.wakes.filter((w) => w.outcome === "done");
  const t = done.map(orderTally);
  const sent = t.reduce((s, x) => s + x.sent, 0);
  const ok = t.reduce((s, x) => s + x.ok, 0);
  const calls = g.wakes.reduce((s, w) => s + w.modelCalls, 0);
  const tin = g.wakes.reduce((s, w) => s + w.usage.promptTokens, 0);
  const tout = g.wakes.reduce((s, w) => s + w.usage.completionTokens, 0);
  const per = (x: number) => (g.wakes.length ? n(x / g.wakes.length) : "-");
  return [
    `\`${c.model}\``,
    cell(c.reachable),
    cell(c.reasoning),
    cell(c.json),
    `${done.length}/${wanted}${g.stopped ? " (stopped)" : ""}`,
    `${ok}/${sent}`,
    `${calls}`,
    `${per(tin)} in, ${per(tout)} out`,
    calls ? `${(g.seconds / calls).toFixed(1)}s` : "-",
  ].join(" | ").replace(/^/, "| ").concat(" |");
}

function details(c: ProbeChecks, g: GameResult | null, effort: string): string[] {
  const lines = [`### \`${c.model}\``, ""];
  lines.push(`Effort used in the wakes: ${c.effort === "default" ? "default" : effort}.`, "");
  if (!g) return [...lines, "Not reachable: no game wakes.", ""];
  if (g.stopped) lines.push(`Stopped: ${g.stopped}`, "");
  for (const w of g.wakes) {
    const t = orderTally(w);
    lines.push(
      `- Wake ${w.slot + 1} (${w.at.slice(11, 16)}): ${w.outcome}${w.error ? ` (${cell(w.error)})` : ""}, ${w.modelCalls} call(s), ${w.lookups.length} lookup(s), ${t.ok}/${t.sent} orders ok, ${n(w.usage.promptTokens)} in (${n(w.usage.cachedTokens)} cached), ${n(w.usage.completionTokens)} out (${n(w.usage.reasoningTokens)} reasoning).`,
    );
    if (w.note) lines.push(`  Note: ${cell(w.note)}`);
    if (w.orders) lines.push(`  Orders: \`${cell(JSON.stringify(w.orders)).slice(0, 600)}\``);
    for (const r of t.refused) lines.push(`  Refused: ${cell(r)}`);
  }
  lines.push("");
  return lines;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "key-env": { type: "string" }, bot: { type: "string" }, wakes: { type: "string" }, out: { type: "string" }, effort: { type: "string" } },
  });
  if (positionals.length === 0) throw new Error("Usage: npm run probe -- [--key-env VAR] [--bot lantern] [--wakes 2] [--out logs/probe] <model> [<model>...]");
  for (const m of positionals) {
    const problem = modelIdProblem(m);
    if (problem) throw new Error(problem);
  }
  const keyEnv = values["key-env"] ?? "NANOGPT_KEY";
  const key = process.env[keyEnv];
  if (!key) throw new Error(`${keyEnv} isn't set in runner.env.`);
  const wakes = Number(values.wakes ?? 2);
  if (!Number.isInteger(wakes) || wakes < 1) throw new Error("--wakes is a whole number from 1.");
  const runner = loadRunner();
  const base = runner.bots.find((b) => b.name === (values.bot ?? "lantern"));
  if (!base) throw new Error(`No bot named "${values.bot ?? "lantern"}" in config/runner.yaml.`);
  if (!runner.week) throw new Error("config/runner.yaml has no `week` block.");
  const out = path.resolve(ROOT, values.out ?? "logs/probe");
  mkdirSync(out, { recursive: true });
  const rules = loadRules();
  const players = loadPlayers();
  const nano = new NanoGptModel(key, { baseUrl: runner.nanogpt_base_url, timeoutSeconds: runner.model_timeout_seconds, maxOutputTokens: runner.max_output_tokens });

  const rows: string[] = [];
  const more: string[] = [];
  for (const model of positionals) {
    console.log(`Probing ${model}…`);
    const checks = await probeChecks(nano, model);
    console.log(`  ${checks.reachable} · reasoning ${checks.reasoning} · JSON ${checks.json}`);
    let game: GameResult | null = null;
    if (isReachable(checks)) {
      const timed = new Timed(nano);
      let stopped: string | null = null;
      // JSON mode off for every model: some answer it with a 502 (DeepSeek
      // V4.1 Flash, 2026-10-07), and the wake takes the object out of prose.
      const effort = values.effort !== undefined && checks.effort !== "default" ? (values.effort as typeof checks.effort) : checks.effort;
      const bot = { ...base, model, fallback_models: [], reasoning_effort: effort, json_mode: false };
      const dir = path.join(out, model.replace(/[^a-z0-9.-]+/gi, "_"));
      rmSync(dir, { recursive: true, force: true });
      const week = await runWeek(
        { model: () => timed, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (line) => {
            console.log(`  ${line}`);
            if (line.startsWith("Stopped")) stopped = line.replace(/ Resume with --resume\.$/, "");
          },
        },
        {
          rules,
          players,
          runner,
          bots: [{ bot, persona: readPersona(base) }],
          dir,
          resume: false,
          options: { ...runner.week, bots: [bot.name], days: 1, wakes_per_day: wakes, opponents: ["builder", "raider"], startedAt: Date.UTC(2026, 9, 5) },
        },
      );
      game = { wakes: week.wakes, seconds: timed.ms / 1000, stopped: week.finished ? null : (stopped ?? "a model call failed") };
    }
    rows.push(row(checks, game, wakes));
    more.push(...details(checks, game, game ? (values.effort ?? checks.effort) : checks.effort));
  }

  const report = [
    `# Capability probe, ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Each model: the runner's checks, then ${wakes} wake(s) of ${base.boot.designation} (${base.boot.architecture}) in a throwaway game against the legacy systems, a builder and a raider, at the --effort given (low unless given; none for a model that refuses the parameter), without JSON mode, which the wake doesn't need. Tokens are per wake; time is per model call.`,
    "",
    "| Model | Reachable | Reasoning (low → high) | JSON mode | Wakes | Orders ok | Calls | Tokens a wake | Time a call |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Each model's wakes",
    "",
    ...more,
  ].join("\n");
  writeFileSync(path.join(out, "report.md"), report);
  console.log(`\n${rows.join("\n")}\n\nReport: ${path.relative(ROOT, path.join(out, "report.md"))}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
