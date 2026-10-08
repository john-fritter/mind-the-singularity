import pg, { Pool } from "pg";
import type { Day } from "./schedule.js";
import type { BotSettings } from "./settings.js";
import { TUNABLE_FIELDS, TunablesSchema, type Tunables } from "./tunables.js";
import type { WakeResult } from "./wake.js";

/**
 * The runner's own tables (migrations/004_runner.sql): its bots' tunables,
 * which the admin edits at /admin/bots, and its wakes. The runner reaches
 * them with its own connection (RUNNER_DATABASE_URL in runner.env), never
 * through src/store/ or the game: it reads the tunables and writes runs.
 */

/** A wake (or a skipped one) as the runner records it. */
export interface RunRecord {
  bot: string;
  /** The local day the wake counts toward. */
  day: Day;
  /** Its slot in the day, or null for a wake by hand. */
  slot: number | null;
  result: WakeResult;
}

/** What today's runs say: slots run or skipped per bot, and tokens spent per bot. */
export interface DayTally {
  slots: Map<string, Set<number>>;
  spent: Map<string, number>;
}

export interface RunnerStore {
  /** Adds each bot not yet in the table, with the file's tunables. Returns the names added. */
  seed(bots: BotSettings[]): Promise<string[]>;
  /** Every bot's tunables, by name. */
  tunables(): Promise<Map<string, Tunables>>;
  tally(day: Day): Promise<DayTally>;
  record(run: RunRecord): Promise<void>;
  close(): Promise<void>;
}

export const spentBy = (r: WakeResult) => r.usage.promptTokens + r.usage.completionTokens;

function addTo(t: DayTally, run: RunRecord) {
  if (run.slot !== null) {
    const set = t.slots.get(run.bot) ?? new Set<number>();
    set.add(run.slot);
    t.slots.set(run.bot, set);
  }
  t.spent.set(run.bot, (t.spent.get(run.bot) ?? 0) + spentBy(run.result));
}

/** The tables in memory, for tests. `bots` may be changed directly, as the admin would. */
export class MemoryRunnerStore implements RunnerStore {
  bots = new Map<string, Tunables>();
  runs: RunRecord[] = [];

  async seed(bots: BotSettings[]): Promise<string[]> {
    const added = bots.filter((b) => !this.bots.has(b.name));
    for (const b of added) this.bots.set(b.name, pickTunables(b));
    return added.map((b) => b.name);
  }
  async tunables() {
    return new Map([...this.bots].map(([k, v]) => [k, { ...v }]));
  }
  async tally(day: Day): Promise<DayTally> {
    const t: DayTally = { slots: new Map(), spent: new Map() };
    for (const run of this.runs) if (run.day === day) addTo(t, run);
    return t;
  }
  async record(run: RunRecord) {
    if (run.slot !== null && this.runs.some((r) => r.bot === run.bot && r.day === run.day && r.slot === run.slot)) return;
    this.runs.push(structuredClone(run));
  }
  async close() {}
}

export function pickTunables(b: Tunables): Tunables {
  return Object.fromEntries(TUNABLE_FIELDS.map((k) => [k, b[k]])) as Tunables;
}

/** A row of runner_bots as Tunables; a row that no longer validates is left out, with why. */
export function rowTunables(row: Record<string, unknown>): Tunables | Error {
  const parsed = TunablesSchema.safeParse({
    model: row["model"],
    fallback_models: row["fallback_models"],
    reasoning_effort: row["reasoning_effort"],
    json_mode: row["json_mode"],
    wakes_per_day: row["wakes_per_day"],
    window: row["window"],
    daily_tokens: row["daily_tokens"] === null ? null : Number(row["daily_tokens"]),
    paused: row["paused"],
  });
  return parsed.success ? parsed.data : new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
}

/** The tables in Postgres. */
export class PostgresRunnerStore implements RunnerStore {
  constructor(
    private readonly pool: Pool,
    private readonly warn: (line: string) => void = console.error,
  ) {}

  static connect(url: string): PostgresRunnerStore {
    // BIGINT token counts fit in a double.
    pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
    return new PostgresRunnerStore(new Pool({ connectionString: url, max: 2, options: "-c search_path=mind" }));
  }

  async seed(bots: BotSettings[]): Promise<string[]> {
    const added: string[] = [];
    for (const b of bots) {
      const t = pickTunables(b);
      const { rowCount } = await this.pool.query(
        `INSERT INTO runner_bots (name, model, fallback_models, reasoning_effort, json_mode, wakes_per_day, "window", daily_tokens, paused)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (name) DO NOTHING`,
        [b.name, t.model, t.fallback_models, t.reasoning_effort, t.json_mode, t.wakes_per_day, t.window, t.daily_tokens, t.paused],
      );
      if (rowCount) added.push(b.name);
    }
    return added;
  }

  async tunables(): Promise<Map<string, Tunables>> {
    const { rows } = await this.pool.query<Record<string, unknown>>("SELECT * FROM runner_bots");
    const out = new Map<string, Tunables>();
    for (const row of rows) {
      const t = rowTunables(row);
      if (t instanceof Error) this.warn(`runner_bots ${String(row["name"])} is invalid, skipped: ${t.message}`);
      else out.set(String(row["name"]), t);
    }
    return out;
  }

  async tally(day: Day): Promise<DayTally> {
    const { rows } = await this.pool.query<{ bot: string; slot: number | null; spent: number }>(
      "SELECT bot, slot, prompt_tokens + completion_tokens AS spent FROM runner_runs WHERE day = $1",
      [day],
    );
    const t: DayTally = { slots: new Map(), spent: new Map() };
    for (const r of rows) {
      if (r.slot !== null) t.slots.set(r.bot, (t.slots.get(r.bot) ?? new Set()).add(r.slot));
      t.spent.set(r.bot, (t.spent.get(r.bot) ?? 0) + Number(r.spent));
    }
    return t;
  }

  async record({ bot, day, slot, result: r }: RunRecord): Promise<void> {
    const detail = { lookups: r.lookups, orders: r.orders, results: r.results, note: r.note, briefChars: r.briefChars, transcript: r.transcript };
    await this.pool.query(
      `INSERT INTO runner_runs (bot, day, slot, at, outcome, error, model, booted, model_calls, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (bot, day, slot) DO NOTHING`,
      [bot, day, slot, r.at, r.outcome, r.error, r.model, r.booted, r.modelCalls, r.usage.promptTokens, r.usage.completionTokens, r.usage.reasoningTokens, r.usage.cachedTokens, JSON.stringify(detail)],
    );
  }

  close() {
    return this.pool.end();
  }
}
