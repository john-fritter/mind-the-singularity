import { z } from "zod";
import { loadSite } from "../config.js";
import { dayOf, nextWake, type Day } from "../runner/schedule.js";
import { parseModelList, REASONING_EFFORTS, TUNABLE_FIELDS, TunablesSchema, type Tunables } from "../runner/tunables.js";

export { REASONING_EFFORTS, type Tunables };
import { gameError, type GameError, type Identity } from "./state.js";

// The bot runner's settings and wakes, for the admin at /admin/bots (phase
// 6b). The runner keeps them in its own tables (mind.runner_*); the admin
// may change a bot's tunables here, and every change is logged with who
// made it, so it can be seen and undone. Like src/game/admin.ts, anyone
// without the admin flag gets "not found" before anything is read. Nothing
// in the game reads these: a bot plays through /mcp with its key, and the
// engine never knows whether a mind is one.

/** A field's value before and after a change. */
export type Changes = Partial<Record<keyof Tunables, { from: unknown; to: unknown }>>;

export interface ConfigChange {
  id: number;
  bot: string;
  by: string;
  at: number;
  changes: Changes;
  /** The change this one undid, if it's an undo. */
  undoes: number | null;
}

/** A wake as the runner recorded it. */
export interface BotRun {
  id: number;
  bot: string;
  day: Day | null;
  /** Its slot in the day; null for a wake by hand. */
  slot: number | null;
  at: number;
  outcome: "done" | "skipped" | "failed";
  error: string | null;
  model: string | null;
  booted: boolean;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** Lookups, orders, results, note and the transcript, as the runner kept them. */
  detail: { lookups?: unknown[]; orders?: unknown[] | null; results?: unknown; note?: string | null; transcript?: { role: string; content: string | null }[] } | null;
}

/** Which runs a wakes list wants: any field left out matches all. */
export interface RunFilter {
  bot?: string | undefined;
  outcome?: BotRun["outcome"] | undefined;
  day?: Day | undefined;
}

export const RUN_OUTCOMES = ["done", "skipped", "failed"] as const;

/** A bot's row: its tunables, or why they no longer read as valid. */
export interface BotEntry {
  name: string;
  tunables: Tunables | null;
  invalid: string | null;
  updatedAt: number;
}

/** The runner's tables, as the site reads and changes them (src/store/runner.ts). */
export interface BotTables {
  /** The runner's timezone and daily budget, from config/runner.yaml. */
  timezone: string;
  budget: number;
  bots(): Promise<BotEntry[]>;
  /** Tokens (prompt plus output) and runs per bot on a local day. */
  day(day: Day): Promise<Map<string, { spent: number; slots: Set<number> }>>;
  /** A bot's newest runs, newest first; all bots' with `bot` null. */
  runs(bot: string | null, limit: number): Promise<BotRun[]>;
  /** Runs matching `filter`: newest first below the id `before`, or oldest first above the id `after`; `limit` at most. */
  find(filter: RunFilter, page: { before?: number; after?: number; limit: number }): Promise<BotRun[]>;
  /** How many runs match `filter`. */
  count(filter: RunFilter): Promise<number>;
  /** The days with runs, newest first. */
  days(): Promise<Day[]>;
  /** A bot's newest changes, newest first. */
  changes(bot: string, limit: number): Promise<ConfigChange[]>;
  /** Sets the tunables and logs the change in one step; null when the bot doesn't exist. */
  update(bot: string, next: Tunables, by: string, undoes: number | null): Promise<ConfigChange | null>;
}

export interface BotRow extends BotEntry {
  spent: number;
  ran: number;
  last: BotRun | null;
  next: number | null;
}

export interface BotsOverview {
  day: Day;
  total: number;
  budget: number;
  timezone: string;
  bots: BotRow[];
  recent: BotRun[];
}

export interface BotPage {
  day: Day;
  timezone: string;
  bot: BotRow;
  runs: BotRun[];
  changes: ConfigChange[];
}

const RUNS_SHOWN = 20;
const CHANGES_SHOWN = 20;

const notFound = () => gameError("not_found", "There's nothing here.");

async function rows(t: BotTables, now: number): Promise<{ day: Day; rows: BotRow[] }> {
  const day = dayOf(now, t.timezone);
  const [bots, today, recent] = await Promise.all([t.bots(), t.day(day), t.runs(null, 500)]);
  return {
    day,
    rows: bots.map((b) => {
      const d = today.get(b.name);
      const done = d?.slots ?? new Set<number>();
      return {
        ...b,
        spent: d?.spent ?? 0,
        ran: done.size,
        last: recent.find((r) => r.bot === b.name) ?? null,
        next: b.tunables && !b.tunables.paused ? nextWake(b.name, b.tunables, now, t.timezone, done).at : null,
      };
    }),
  };
}

/** Every bot, today's spend against the budget, and the latest wakes. */
export async function botsOverview(t: BotTables | undefined, identity: Identity, now: number): Promise<BotsOverview | GameError> {
  if (identity.admin !== true || !t) return notFound();
  const { day, rows: bots } = await rows(t, now);
  return { day, total: bots.reduce((s, b) => s + b.spent, 0), budget: t.budget, timezone: t.timezone, bots, recent: await t.runs(null, RUNS_SHOWN) };
}

/** One bot: its settings, its recent wakes and the changes to it. */
export async function botPage(t: BotTables | undefined, identity: Identity, name: string, now: number): Promise<BotPage | GameError> {
  if (identity.admin !== true || !t) return notFound();
  const { day, rows: bots } = await rows(t, now);
  const bot = bots.find((b) => b.name === name);
  if (!bot) return gameError("not_found", `No bot called ${name}.`);
  const [runs, changes] = await Promise.all([t.runs(name, RUNS_SHOWN), t.changes(name, CHANGES_SHOWN)]);
  return { day, timezone: t.timezone, bot, runs, changes };
}

/** Every wake, newest first, filtered by bot, outcome and day; with what the filters may pick from. */
export interface WakesPage {
  timezone: string;
  bots: string[];
  days: Day[];
  runs: BotRun[];
  more: boolean;
  matched: number;
  total: number;
}

const WakesQuery = z.strictObject({
  bot: z.string().trim().min(1).max(80).optional(),
  outcome: z.enum(RUN_OUTCOMES).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day is YYYY-MM-DD").optional(),
  before: z.coerce.number().int().positive().optional(),
});

function wakesQuery(query: unknown): { filter: RunFilter; before: number | undefined } | GameError {
  const q = WakesQuery.safeParse(query);
  if (!q.success) return gameError("invalid", z.prettifyError(q.error));
  return { filter: { bot: q.data.bot, outcome: q.data.outcome, day: q.data.day }, before: q.data.before };
}

/** A page of wakes: the newest `web.admin_wakes` that match, below `before`. */
export async function botWakes(t: BotTables | undefined, identity: Identity, query: unknown): Promise<WakesPage | GameError> {
  if (identity.admin !== true || !t) return notFound();
  const q = wakesQuery(query);
  if ("ok" in q) return q;
  const limit = loadSite().web.admin_wakes;
  const [bots, days, found, matched, total] = await Promise.all([
    t.bots(),
    t.days(),
    t.find(q.filter, { before: q.before, limit: limit + 1 }),
    t.count(q.filter),
    t.count({}),
  ]);
  return {
    timezone: t.timezone,
    bots: bots.map((b) => b.name),
    days,
    runs: found.slice(0, limit),
    more: found.length > limit,
    matched,
    total,
  };
}

/** How many wakes a download reads at a time, so a long epoch's transcripts never sit in memory at once. */
const WAKES_BATCH = 50;

/** Every matching wake, oldest first, a batch at a time, for a download. */
export async function wholeWakes(
  t: BotTables | undefined,
  identity: Identity,
  query: unknown,
): Promise<{ batches: () => AsyncGenerator<BotRun[]> } | GameError> {
  if (identity.admin !== true || !t) return notFound();
  const q = wakesQuery(query);
  if ("ok" in q) return q;
  const { filter } = q;
  return {
    async *batches() {
      let after = 0;
      for (;;) {
        const runs = await t.find(filter, { after, limit: WAKES_BATCH });
        if (runs.length === 0) return;
        yield runs;
        after = runs.at(-1)!.id;
        if (runs.length < WAKES_BATCH) return;
      }
    },
  };
}

/** The settings form's fields, as text. */
const FormSchema = z.strictObject({
  model: z.string().trim(),
  fallback_models: z.string().default(""),
  reasoning_effort: z.string(),
  json_mode: z.string().optional(),
  wakes_per_day: z.coerce.number(),
  window: z.string().trim(),
  daily_tokens: z.string().trim().default(""),
  paused: z.string().optional(),
});

/** The form's text as tunables, or what's wrong with it. */
export function tunablesFromForm(form: Record<string, string>): Tunables | GameError {
  const f = FormSchema.safeParse(form);
  if (!f.success) return gameError("invalid", z.prettifyError(f.error));
  const cap = f.data.daily_tokens.replace(/[,_\s]/g, "");
  const t = TunablesSchema.safeParse({
    model: f.data.model,
    fallback_models: parseModelList(f.data.fallback_models),
    reasoning_effort: f.data.reasoning_effort,
    json_mode: f.data.json_mode !== undefined,
    wakes_per_day: f.data.wakes_per_day,
    window: f.data.window,
    daily_tokens: cap === "" ? null : Number(cap),
    paused: f.data.paused !== undefined,
  });
  if (!t.success) return gameError("invalid", t.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" "));
  return t.data;
}

function diff(before: Tunables, after: Tunables): Changes {
  const out: Changes = {};
  for (const k of TUNABLE_FIELDS) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k], to: after[k] };
  }
  return out;
}

/** Changes a bot's tunables from the settings form. The change is logged; no change logs nothing. */
export async function changeBot(
  t: BotTables | undefined,
  identity: Identity,
  name: string,
  form: Record<string, string>,
): Promise<{ ok: true; change: ConfigChange | null } | GameError> {
  if (identity.admin !== true || !t) return notFound();
  const bot = (await t.bots()).find((b) => b.name === name);
  if (!bot) return gameError("not_found", `No bot called ${name}.`);
  const next = tunablesFromForm(form);
  if ("ok" in next) return next;
  if (bot.tunables && Object.keys(diff(bot.tunables, next)).length === 0) return { ok: true, change: null };
  return { ok: true, change: await t.update(name, next, identity.account, null) };
}

/** Undoes one logged change: each field it changed goes back to its old value, as a new change. */
export async function undoChange(t: BotTables | undefined, identity: Identity, name: string, id: number): Promise<{ ok: true; change: ConfigChange | null } | GameError> {
  if (identity.admin !== true || !t) return notFound();
  const bot = (await t.bots()).find((b) => b.name === name);
  const change = (await t.changes(name, 1_000)).find((c) => c.id === id);
  if (!bot || !change) return gameError("not_found", "There's no such change.");
  const back: Record<string, unknown> = { ...(bot.tunables ?? {}) };
  for (const [k, v] of Object.entries(change.changes)) back[k] = v.from;
  const next = TunablesSchema.safeParse(back);
  if (!next.success) return gameError("invalid", `That change can't be undone: ${next.error.issues[0]?.message ?? "invalid"}`);
  if (bot.tunables && Object.keys(diff(bot.tunables, next.data)).length === 0) return { ok: true, change: null };
  return { ok: true, change: await t.update(name, next.data, identity.account, id) };
}

export { diff as tunablesDiff };
