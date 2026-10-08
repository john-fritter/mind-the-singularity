import { z } from "zod";

/**
 * A bot's tunable settings: the ones the admin may change at /admin/bots
 * (phase 6b) as well as config/runner.yaml. Shared by the runner and the
 * site's admin pages (src/game/bots.ts), so both read the same text the
 * same way ("08:00-24:00", "a, b"). Pure: no I/O, no model calls.
 */

/** "default" sends no reasoning_effort at all, for models that refuse the parameter. */
export const REASONING_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Model ids with these suffixes turn on paid extras (web search, memory) or
 * provider routing, which NanoGPT bills pay-as-you-go even on a subscription.
 */
const PAID_SUFFIX = /:(online|memory|fast|cheap|caching|cache|cached)\b/i;

export function modelIdProblem(model: string): string | null {
  if (!model.trim()) return "A model id is required.";
  if (/\s/.test(model)) return "Model ids have no spaces.";
  if (PAID_SUFFIX.test(model)) return `${model} carries a suffix that bills outside the subscription; use the plain model id.`;
  return null;
}

const modelId = z.string().superRefine((m, ctx) => {
  const problem = modelIdProblem(m);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** "08:00" as minutes after midnight; "24:00" is the day's end. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** The waking window, "08:00-24:00", as minutes after local midnight; the end is after the start. */
export function parseWindow(value: string): { start: number; end: number } | null {
  const m = /^\s*([\d:]+)\s*-\s*([\d:]+)\s*$/.exec(value);
  if (!m) return null;
  const start = parseTimeOfDay(m[1]!);
  const end = parseTimeOfDay(m[2]!);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

const window = z.string().refine((w) => parseWindow(w) !== null, { message: 'a waking window like "08:00-24:00", the end after the start, inside one day' });

export const TunablesSchema = z.strictObject({
  model: modelId,
  /** Tried in order when the bot's model fails twice in a way that may pass; the first to answer serves the rest of the wake. */
  fallback_models: z.array(modelId),
  reasoning_effort: z.enum(REASONING_EFFORTS),
  /** Ask the model for a JSON object (response_format). Off for models that refuse it. */
  json_mode: z.boolean(),
  /** Wakes a day, one in each equal slot of the waking window. */
  wakes_per_day: z.number().int().min(1).max(96),
  /** When the bot is awake, in the runner's timezone: "08:00-24:00". */
  window,
  /** The bot's own cap on tokens a day (prompt plus output); null for none but the runner's budget. */
  daily_tokens: z.number().int().positive().nullable(),
  /** A paused bot doesn't wake. */
  paused: z.boolean(),
});
export type Tunables = z.infer<typeof TunablesSchema>;
export const TUNABLE_FIELDS = Object.keys(TunablesSchema.shape) as (keyof Tunables)[];

/** A comma-separated list of model ids, as a form gives it. */
export function parseModelList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
