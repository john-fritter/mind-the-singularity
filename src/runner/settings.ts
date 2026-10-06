import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { modelIdProblem, REASONING_EFFORTS } from "./model.js";

// The runner's knobs and its bots: config/runner.yaml, validated here. The
// runner reads its own file rather than src/config.ts, which loads the
// game's rules: it knows the game only through the MCP server. Secrets
// are never here; a bot names the variables in runner.env that hold them.

export const ROOT = path.join(import.meta.dirname, "..", "..");
export const RUNNER_PATH = path.join(ROOT, "config", "runner.yaml");

const count = z.number().int().positive();
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable's name, in capitals");

const BotSchema = z.strictObject({
  /** How the runner names the bot: `npm run runner -- wake <name>`. */
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, _ and -"),
  /** The persona prompt, a file under the repo, in the second person. */
  persona: z.string().min(1),
  model: z.string().superRefine((m, ctx) => {
    const problem = modelIdProblem(m);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  reasoning_effort: z.enum(REASONING_EFFORTS),
  /** Ask the model for a JSON object (response_format). Off for models that refuse it. */
  json_mode: z.boolean(),
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
export type BotSettings = z.infer<typeof BotSchema>;

/** The simulated week (npm run week): one bot against scripted players on a fake clock. */
const WeekSchema = z.strictObject({
  /** The bot that plays, from `bots`. */
  bot: z.string().min(1),
  days: count,
  /** The bot wakes once in each slot of 24h / wakes_per_day, at a seeded minute inside it. */
  wakes_per_day: count,
  /** Scripted opponents' strategies (config/players.yaml), one mind each. */
  opponents: z.array(z.string().min(1)),
  /** Seeds the epoch, the opponents and the bot's wake times. */
  seed: z.number().int(),
  /** DESIGN.md's ceiling on a brief, in tokens (gpt-tokenizer); the week fails past it. */
  brief_ceiling_tokens: count,
  /** Where the save, the wake log and the report go, under the repo (gitignored). */
  out_dir: z.string().min(1),
});
export type WeekSettings = z.infer<typeof WeekSchema>;

export const RunnerSchema = z
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
    bots: z.array(BotSchema),
    /** The simulated week's knobs; only npm run week needs them. */
    week: WeekSchema.optional(),
  })
  .refine((r) => new Set(r.bots.map((b) => b.name)).size === r.bots.length, { message: "bot names must be unique" })
  .refine((r) => !r.week || r.bots.some((b) => b.name === r.week!.bot), { message: "week.bot must name one of the bots" });
export type RunnerSettings = z.infer<typeof RunnerSchema>;

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
