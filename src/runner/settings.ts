import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { TunablesSchema, type Tunables } from "./tunables.js";

// The runner's knobs and its bots: config/runner.yaml, validated here. The
// runner reads its own file rather than src/config.ts, which loads the
// game's rules: it knows the game only through the MCP server. Secrets
// are never here; a bot names the variables in runner.env that hold them.

export const ROOT = path.join(import.meta.dirname, "..", "..");
export const RUNNER_PATH = path.join(ROOT, "config", "runner.yaml");

const count = z.number().int().positive();
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable's name, in capitals");

/**
 * A bot as config/runner.yaml lists it. Its tunables (tunables.ts) are each
 * optional, falling back to `defaults`; once the bot is in the database,
 * the database's copy wins (the admin's /admin/bots).
 */
const BotFileSchema = TunablesSchema.partial().extend({
  /** How the runner names the bot: `npm run runner -- wake <name>`. */
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, _ and -"),
  /** The persona prompt, a file under the repo, in the second person. */
  persona: z.string().min(1),
  /** The runner.env variable holding the bot's game API key (npm run key). */
  game_key_env: envName,
  /** The runner.env variable holding its NanoGPT key. */
  model_key_env: envName,
  /** What it boots as, when it has no mind or may boot again. */
  boot: z.strictObject({
    designation: z.string().min(1),
    domain_name: z.string().min(1),
    architecture: z.string().min(1),
    manifesto: z.string().optional(),
  }),
});
type BotFile = z.infer<typeof BotFileSchema>;

/** A bot with every setting resolved: the file's own, then `defaults`, or the database's tunables. */
export type BotSettings = Omit<BotFile, keyof Tunables> & Tunables;

/** A bot's tunables, as the file gives them over the defaults. */
export function fileTunables(defaults: Tunables, bot: BotFile): Tunables {
  const out = { ...defaults };
  for (const k of Object.keys(defaults) as (keyof Tunables)[]) if (bot[k] !== undefined) (out as Record<string, unknown>)[k] = bot[k];
  return out;
}

/** The bot with these tunables in place of its own. */
export function withTunables(bot: BotSettings, t: Tunables): BotSettings {
  return { ...bot, ...t };
}

/** The simulated week (npm run week): model bots against scripted players on a fake clock. */
const WeekSchema = z.strictObject({
  /** The bots that play, from `bots`. */
  bots: z.array(z.string().min(1)).min(1),
  days: count,
  /** Each bot wakes once in each slot of 24h / wakes_per_day, at a seeded minute inside it. */
  wakes_per_day: count,
  /** Scripted opponents' strategies (config/players.yaml), one mind each. */
  opponents: z.array(z.string().min(1)),
  /** Seeds the epoch, the opponents and the bots' wake times. */
  seed: z.number().int(),
  /** DESIGN.md's ceiling on a brief, in tokens (gpt-tokenizer); the week fails past it. */
  brief_ceiling_tokens: count,
  /** Where the save, the wake log and the report go, under the repo (gitignored). */
  out_dir: z.string().min(1),
});
export type WeekSettings = z.infer<typeof WeekSchema>;

const RunnerFileSchema = z
  .strictObject({
    /** The game's MCP server; MCP_URL in runner.env overrides it. */
    mcp_url: z.url(),
    /** NanoGPT's subscription URL: only subscription models, never prepaid balance. */
    nanogpt_base_url: z.url(),
    model_timeout_seconds: count,
    /** Output cap per model call, reasoning included. */
    max_output_tokens: count,
    /** A failed model call (other than the daily cap) is tried once more after this. */
    retry_wait_seconds: z.number().int().nonnegative(),
    /** Lookups the model may ask for in a wake's one lookup round. */
    lookups_per_wake: count,
    /** Rules topics fetched from the server into every wake's static prompt. */
    rules_topics: z.array(z.string().min(1)),
    /** Each wake's result is appended here as a line of JSON, under the repo. */
    log_path: z.string().min(1),
    /** The IANA timezone the waking windows and the budget's day are read in. */
    timezone: z.string().refine(validTimeZone, { message: "an IANA timezone, like UTC or America/Los_Angeles" }),
    /** Tokens (prompt plus output) all bots together may spend in a day, from midnight in the timezone. */
    daily_token_budget: count,
    /** How often `serve` looks for due wakes. */
    tick_seconds: count,
    /** Every bot's tunables unless it gives its own. */
    defaults: TunablesSchema,
    bots: z.array(BotFileSchema),
    /** The simulated week's knobs; only npm run week needs them. */
    week: WeekSchema.optional(),
  })
  .refine((r) => new Set(r.bots.map((b) => b.name)).size === r.bots.length, { message: "bot names must be unique" })
  .refine((r) => !r.week || r.week.bots.every((name) => r.bots.some((b) => b.name === name)), { message: "week.bots must name bots in `bots`" })
  .refine((r) => !r.week || new Set(r.week.bots).size === r.week.bots.length, { message: "week.bots must not repeat a bot" });

export const RunnerSchema = RunnerFileSchema.transform(({ bots, ...rest }) => ({
  ...rest,
  bots: bots.map((b): BotSettings => ({ ...b, ...fileTunables(rest.defaults, b) })),
}));
export type RunnerSettings = z.infer<typeof RunnerSchema>;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parses and validates runner YAML. Throws one error listing every problem. */
export function parseRunner(text: string, source = "runner"): RunnerSettings {
  const result = RunnerSchema.safeParse(YAML.parse(text));
  if (!result.success) {
    throw new Error(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** The runner's settings, read from config/runner.yaml. */
export function loadRunner(): RunnerSettings {
  return parseRunner(readFileSync(RUNNER_PATH, "utf-8"), "config/runner.yaml");
}

/** A bot's persona prompt, read from its file. */
export function readPersona(bot: BotSettings): string {
  return readFileSync(path.resolve(ROOT, bot.persona), "utf-8").trim();
}
