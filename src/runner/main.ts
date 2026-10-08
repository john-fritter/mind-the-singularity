/**
 * The bot runner, by hand: one wake of one bot from config/runner.yaml.
 *
 * Usage:
 *   npm run runner -- serve          the service: every bot on its schedule, until stopped
 *   npm run runner -- status         today's tokens against the budget, and each bot's next wake
 *   npm run runner -- wake <bot>     one wake: brief, model, orders
 *   npm run runner -- prompt <bot>   the prompts and the brief, without calling a model
 *   npm run runner -- bots           the bots in config/runner.yaml
 *
 * Secrets come from runner.env (see runner.env.example), never .env.
 * `serve` and `status` need RUNNER_DATABASE_URL: the bots' tunables (which
 * the admin edits at /admin/bots) and every wake are kept there. With it, a
 * wake by hand uses the database's tunables and is recorded there too;
 * without it, the file's settings and the log file (log_path).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { httpGame } from "./mcp.js";
import { NanoGptModel } from "./model.js";
import { RunnerService } from "./service.js";
import { dayOf } from "./schedule.js";
import { loadRunner, readPersona, ROOT, withTunables, type BotSettings, type RunnerSettings } from "./settings.js";
import { PostgresRunnerStore, type RunnerStore } from "./store.js";
import { readBrief, runWake, staticPrompt, type WakeResult } from "./wake.js";
import { wakeMessage } from "./prompts.js";

dotenv.config({ path: path.join(ROOT, "runner.env"), quiet: true });

const USAGE = `Usage:
  npm run runner -- serve
  npm run runner -- status
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

/** The runner's tables, if RUNNER_DATABASE_URL is set. */
function openStore(required: boolean): RunnerStore | null {
  const url = process.env["RUNNER_DATABASE_URL"];
  if (!url && required) throw new Error("RUNNER_DATABASE_URL isn't set in runner.env.");
  return url ? PostgresRunnerStore.connect(url) : null;
}

function modelFor(settings: RunnerSettings) {
  return (bot: BotSettings) =>
    new NanoGptModel(secret(bot.model_key_env), {
      baseUrl: settings.nanogpt_base_url,
      timeoutSeconds: settings.model_timeout_seconds,
      maxOutputTokens: settings.max_output_tokens,
    });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

function service(settings: RunnerSettings, store: RunnerStore): RunnerService {
  return new RunnerService(
    {
      store,
      settings,
      connect: httpGame(mcpUrl(settings)),
      modelFor: modelFor(settings),
      gameKey: (bot) => secret(bot.game_key_env),
      persona: readPersona,
      now: () => Date.now(),
      sleep,
    },
    Date.now(),
  );
}

/** One line for a wake in the service's output. */
function runLine(r: WakeResult): string {
  const tokens = r.usage.promptTokens + r.usage.completionTokens;
  const results = (r.results as { results?: { ok: boolean }[] } | null)?.results ?? [];
  const orders = r.outcome === "done" ? `, ${results.filter((x) => x.ok).length}/${results.length} orders ok` : "";
  return `${r.bot}: ${r.outcome}${r.error ? ` (${r.error})` : ""}${orders}${r.model ? ` on ${r.model}` : ""}, ${r.modelCalls} call(s), ${tokens} tokens`;
}

async function serveForever(settings: RunnerSettings): Promise<void> {
  const store = openStore(true)!;
  const svc = service(settings, store);
  const added = await svc.seed();
  if (added.length) log(`Added to the database from config/runner.yaml: ${added.join(", ")}.`);
  log(`Serving ${settings.bots.length} bot(s) from ${mcpUrl(settings)}, budget ${settings.daily_token_budget} tokens a day (${settings.timezone}).`);
  let stopping = false;
  let wake: () => void = () => {};
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("Stopping after the wake in hand.");
    wake();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    try {
      for (const run of await svc.tick(Date.now(), () => stopping)) log(runLine(run.result));
    } catch (err) {
      log(`The tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, settings.tick_seconds * 1000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await store.close();
}

async function status(settings: RunnerSettings): Promise<string> {
  const store = openStore(true)!;
  try {
    const s = await service(settings, store).status(Date.now());
    const lines = [`${s.day} (${settings.timezone}): ${s.total} of ${s.budget} tokens spent.`];
    for (const b of s.bots) {
      const t = b.tunables;
      if (!t) {
        lines.push(`${b.name.padEnd(16)} not in the database yet (serve adds it)`);
        continue;
      }
      const next = t.paused ? "paused" : b.next ? `next ${new Date(b.next.at).toISOString().slice(0, 16)}Z` : "-";
      const cap = t.daily_tokens !== null ? ` of ${t.daily_tokens}` : "";
      lines.push(`${b.name.padEnd(16)} ${t.model} (${t.reasoning_effort}) · ${t.wakes_per_day}/day ${t.window} · ${b.ran} run · ${b.spent}${cap} tokens · ${next}`);
    }
    return lines.join("\n");
  } finally {
    await store.close();
  }
}

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
  const lines = [`${r.bot} at ${r.at}: ${r.outcome}${r.error ? ` (${r.error})` : ""}${r.booted ? ", booted" : ""}${r.model ? ` on ${r.model}` : ""}`];
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

async function wake(settings: RunnerSettings, file: BotSettings): Promise<string> {
  const store = openStore(false);
  try {
    let bot = file;
    if (store) {
      await store.seed([file]);
      const t = (await store.tunables()).get(file.name);
      if (t) bot = withTunables(file, t);
    }
    const result = await runWake(
      { connect: httpGame(mcpUrl(settings)), model: modelFor(settings)(bot), now: () => new Date(), sleep },
      settings,
      bot,
      readPersona(bot),
      { gameKey: secret(bot.game_key_env) },
    );
    if (store) {
      await store.record({ bot: bot.name, day: dayOf(Date.parse(result.at), settings.timezone), slot: null, result });
    } else {
      const file = path.resolve(ROOT, settings.log_path);
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(result)}\n`);
    }
    if (result.outcome === "failed") process.exitCode = 1;
    return summary(result);
  } finally {
    await store?.close();
  }
}

async function main() {
  const [command, name] = process.argv.slice(2);
  const settings = loadRunner();
  if (command === "bots") {
    console.log(settings.bots.map((b) => `${b.name.padEnd(16)} ${b.model} · ${b.boot.designation} (${b.boot.architecture})`).join("\n") || "No bots.");
  } else if (command === "serve") {
    await serveForever(settings);
  } else if (command === "status") {
    console.log(await status(settings));
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
