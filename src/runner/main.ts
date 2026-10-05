/**
 * The bot runner, by hand: one wake of one bot from config/runner.yaml.
 *
 * Usage:
 *   npm run runner -- wake <bot>     one wake: brief, model, orders
 *   npm run runner -- prompt <bot>   the prompts and the brief, without calling a model
 *   npm run runner -- bots           the bots in config/runner.yaml
 *
 * Secrets come from runner.env (see runner.env.example), never .env. A wake
 * prints what it did and appends it to the log (log_path) as one line of
 * JSON. Schedules, many bots and run logs in a database are phase 6's.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { httpGame } from "./mcp.js";
import { NanoGptModel } from "./model.js";
import { loadRunner, readPersona, ROOT, type BotSettings, type RunnerSettings } from "./settings.js";
import { readBrief, runWake, staticPrompt, type WakeResult } from "./wake.js";
import { wakeMessage } from "./prompts.js";

dotenv.config({ path: path.join(ROOT, "runner.env"), quiet: true });

const USAGE = `Usage:
  npm run runner -- wake <bot>
  npm run runner -- prompt <bot>
  npm run runner -- bots`;

function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set in runner.env.`);
  return value;
}

function findBot(settings: RunnerSettings, name: string | undefined): BotSettings {
  const bot = settings.bots.find((b) => b.name === name);
  if (!bot) throw new Error(`No bot named "${name ?? ""}" in config/runner.yaml. ${USAGE}`);
  return bot;
}

const mcpUrl = (settings: RunnerSettings) => process.env["MCP_URL"] ?? settings.mcp_url;

/** A rough token count for reading at a glance: about four characters a token. */
const tokens = (text: string) => Math.round(text.length / 4);

async function prompt(settings: RunnerSettings, bot: BotSettings): Promise<string> {
  const game = await httpGame(mcpUrl(settings))(secret(bot.game_key_env));
  try {
    const system = await staticPrompt(game, settings, readPersona(bot));
    const read = await readBrief(game, bot, false);
    const user = "skip" in read ? `(no wake: ${read.skip})` : wakeMessage(read.brief);
    return [
      "── system",
      system,
      "── user",
      user,
      "──",
      `system ${system.length} chars (~${tokens(system)} tokens) · user ${user.length} chars (~${tokens(user)} tokens)`,
    ].join("\n");
  } finally {
    await game.close().catch(() => {});
  }
}

function summary(r: WakeResult): string {
  const lines = [`${r.bot} at ${r.at}: ${r.outcome}${r.error ? ` (${r.error})` : ""}${r.booted ? ", booted" : ""}`];
  lines.push(
    `model calls ${r.modelCalls} · tokens in ${r.usage.promptTokens} (cached ${r.usage.cachedTokens}) out ${r.usage.completionTokens} (reasoning ${r.usage.reasoningTokens}) · brief ${r.briefChars ?? "-"} chars`,
  );
  if (r.lookups.length) lines.push(`lookups: ${JSON.stringify(r.lookups)}`);
  if (r.note) lines.push(`note: ${r.note}`);
  const results = (r.results as { results?: { ok: boolean; message?: string }[] } | null)?.results ?? [];
  (r.orders ?? []).forEach((order, i) => {
    const res = results[i];
    lines.push(`  ${res ? (res.ok ? "ok  " : "FAIL") : "    "} ${JSON.stringify(order)}${res?.message ? `: ${res.message}` : ""}`);
  });
  return lines.join("\n");
}

async function wake(settings: RunnerSettings, bot: BotSettings): Promise<string> {
  const model = new NanoGptModel(secret(bot.model_key_env), {
    baseUrl: settings.nanogpt_base_url,
    timeoutSeconds: settings.model_timeout_seconds,
    maxOutputTokens: settings.max_output_tokens,
  });
  const result = await runWake(
    { connect: httpGame(mcpUrl(settings)), model, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    settings,
    bot,
    readPersona(bot),
    { gameKey: secret(bot.game_key_env) },
  );
  const log = path.resolve(ROOT, settings.log_path);
  mkdirSync(path.dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify(result)}\n`);
  if (result.outcome === "failed") process.exitCode = 1;
  return summary(result);
}

async function main() {
  const [command, name] = process.argv.slice(2);
  const settings = loadRunner();
  if (command === "bots") {
    console.log(settings.bots.map((b) => `${b.name.padEnd(16)} ${b.model} · ${b.boot.designation} (${b.boot.architecture})`).join("\n") || "No bots.");
  } else if (command === "prompt") {
    console.log(await prompt(settings, findBot(settings, name)));
  } else if (command === "wake") {
    console.log(await wake(settings, findBot(settings, name)));
  } else {
    console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
