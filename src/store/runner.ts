import type { Pool } from "pg";
import { withTransaction } from "../db/index.js";
import { tunablesDiff, type BotEntry, type BotRun, type BotTables, type Changes, type ConfigChange } from "../game/bots.js";
import type { Day } from "../runner/schedule.js";
import { rowTunables, type RunRecord } from "../runner/store.js";
import type { Tunables } from "../runner/tunables.js";

// The runner's tables (migrations/004_runner.sql) as the site reads and
// changes them for /admin/bots (src/game/bots.ts). The runner itself has
// its own access (src/runner/store.ts).

const at = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const dayText = (v: unknown): Day | null => (v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function entry(row: Record<string, unknown>): BotEntry {
  const t = rowTunables(row);
  return { name: String(row["name"]), tunables: t instanceof Error ? null : t, invalid: t instanceof Error ? t.message : null, updatedAt: at(row["updated_at"]) };
}

function run(row: Record<string, unknown>): BotRun {
  return {
    id: Number(row["id"]),
    bot: String(row["bot"]),
    day: dayText(row["day"]),
    slot: row["slot"] === null ? null : Number(row["slot"]),
    at: at(row["at"]),
    outcome: row["outcome"] as BotRun["outcome"],
    error: (row["error"] as string | null) ?? null,
    model: (row["model"] as string | null) ?? null,
    booted: row["booted"] === true,
    modelCalls: Number(row["model_calls"]),
    promptTokens: Number(row["prompt_tokens"]),
    completionTokens: Number(row["completion_tokens"]),
    reasoningTokens: Number(row["reasoning_tokens"]),
    cachedTokens: Number(row["cached_tokens"]),
    detail: (row["detail"] as BotRun["detail"]) ?? null,
  };
}

function change(row: Record<string, unknown>): ConfigChange {
  return {
    id: Number(row["id"]),
    bot: String(row["bot"]),
    by: String(row["changed_by"]),
    at: at(row["at"]),
    changes: row["changes"] as Changes,
    undoes: row["undoes"] === null ? null : Number(row["undoes"]),
  };
}

export function postgresBotTables(pool: Pool, settings: { timezone: string; budget: number }): BotTables {
  return {
    ...settings,
    async bots() {
      const { rows } = await pool.query<Record<string, unknown>>("SELECT * FROM runner_bots ORDER BY name");
      return rows.map(entry);
    },
    async day(day) {
      const { rows } = await pool.query<{ bot: string; slot: number | null; spent: number }>(
        "SELECT bot, slot, prompt_tokens + completion_tokens AS spent FROM runner_runs WHERE day = $1",
        [day],
      );
      const out = new Map<string, { spent: number; slots: Set<number> }>();
      for (const r of rows) {
        const d = out.get(r.bot) ?? { spent: 0, slots: new Set<number>() };
        d.spent += Number(r.spent);
        if (r.slot !== null) d.slots.add(Number(r.slot));
        out.set(r.bot, d);
      }
      return out;
    },
    async runs(bot, limit) {
      const { rows } = bot === null
        ? await pool.query<Record<string, unknown>>("SELECT * FROM runner_runs ORDER BY id DESC LIMIT $1", [limit])
        : await pool.query<Record<string, unknown>>("SELECT * FROM runner_runs WHERE bot = $1 ORDER BY id DESC LIMIT $2", [bot, limit]);
      return rows.map(run);
    },
    async changes(bot, limit) {
      const { rows } = await pool.query<Record<string, unknown>>("SELECT * FROM runner_config_log WHERE bot = $1 ORDER BY id DESC LIMIT $2", [bot, limit]);
      return rows.map(change);
    },
    async update(bot, next, by, undoes) {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query<Record<string, unknown>>("SELECT * FROM runner_bots WHERE name = $1 FOR UPDATE", [bot]);
        if (!rows[0]) return null;
        const before = rowTunables(rows[0]);
        const changes = before instanceof Error ? wholeChange(next) : tunablesDiff(before, next);
        await client.query(
          `UPDATE runner_bots SET model = $2, fallback_models = $3, reasoning_effort = $4, json_mode = $5, wakes_per_day = $6,
             "window" = $7, daily_tokens = $8, paused = $9, updated_at = NOW() WHERE name = $1`,
          [bot, next.model, next.fallback_models, next.reasoning_effort, next.json_mode, next.wakes_per_day, next.window, next.daily_tokens, next.paused],
        );
        const logged = await client.query<Record<string, unknown>>(
          "INSERT INTO runner_config_log (bot, changed_by, changes, undoes) VALUES ($1, $2, $3, $4) RETURNING *",
          [bot, by, JSON.stringify(changes), undoes],
        );
        return change(logged.rows[0]!);
      });
    },
  };
}

/** A change from settings that no longer read as valid: every field, from unknown. */
function wholeChange(next: Tunables): Changes {
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, { from: null, to: v }])) as Changes;
}

/** The tables in memory, for tests: bots and runs given directly, changes kept as Postgres would. */
export function memoryBotTables(settings: { timezone: string; budget: number }, bots: Map<string, Tunables>, runs: RunRecord[] = []): BotTables {
  const log: ConfigChange[] = [];
  const asRun = (r: RunRecord, i: number): BotRun => ({
    id: i + 1,
    bot: r.bot,
    day: r.day,
    slot: r.slot,
    at: Date.parse(r.result.at),
    outcome: r.result.outcome,
    error: r.result.error,
    model: r.result.model,
    booted: r.result.booted,
    modelCalls: r.result.modelCalls,
    ...r.result.usage,
    detail: { lookups: r.result.lookups, orders: r.result.orders, results: r.result.results, note: r.result.note, transcript: r.result.transcript },
  });
  return {
    ...settings,
    async bots() {
      return [...bots].sort(([a], [b]) => a.localeCompare(b)).map(([name, t]) => ({ name, tunables: { ...t }, invalid: null, updatedAt: 0 }));
    },
    async day(day) {
      const out = new Map<string, { spent: number; slots: Set<number> }>();
      for (const r of runs.filter((x) => x.day === day)) {
        const d = out.get(r.bot) ?? { spent: 0, slots: new Set<number>() };
        d.spent += r.result.usage.promptTokens + r.result.usage.completionTokens;
        if (r.slot !== null) d.slots.add(r.slot);
        out.set(r.bot, d);
      }
      return out;
    },
    async runs(bot, limit) {
      return runs
        .map(asRun)
        .filter((r) => bot === null || r.bot === bot)
        .reverse()
        .slice(0, limit);
    },
    async changes(bot, limit) {
      return log.filter((c) => c.bot === bot).reverse().slice(0, limit);
    },
    async update(bot, next, by, undoes) {
      const before = bots.get(bot);
      if (!before) return null;
      const c: ConfigChange = { id: log.length + 1, bot, by, at: 0, changes: tunablesDiff(before, next), undoes };
      bots.set(bot, { ...next });
      log.push(c);
      return c;
    },
  };
}
