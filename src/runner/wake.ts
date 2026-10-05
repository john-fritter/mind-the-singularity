import { z } from "zod";
import { ModelError, type ChatMessage, type ChatModel, type ChatResponse, type Usage } from "./model.js";
import type { ConnectGame, GameSession, ToolResult } from "./mcp.js";
import { lookupMessage, retryMessage, rolePrompt, systemPrompt, wakeMessage } from "./prompts.js";
import type { BotSettings, RunnerSettings } from "./settings.js";

/**
 * One wake of one bot, single-shot, as DESIGN.md's "One wake" and Fritter
 * Board's single-shot mode: fetch the brief (booting the mind first if it
 * has none), one model call with the static prompts first and the brief
 * last, optionally one lookup round, then the orders through submit_orders.
 * A reply that can't be used, or a list the game refuses whole, gets one
 * retry with the error. Everything goes through the MCP server as the bot.
 */

export interface WakeDeps {
  connect: ConnectGame;
  model: ChatModel;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

/** The secrets a wake needs, read from runner.env by the caller. */
export interface WakeSecrets {
  gameKey: string;
}

export type Outcome = "done" | "skipped" | "failed";

export interface WakeResult {
  bot: string;
  at: string;
  outcome: Outcome;
  /** Why it failed or was skipped. */
  error: string | null;
  /** Booted (or rebooted) the mind this wake. */
  booted: boolean;
  modelCalls: number;
  usage: Usage;
  /** The brief's length in characters, as read this wake. */
  briefChars: number | null;
  lookups: unknown[];
  orders: unknown[] | null;
  /** What submit_orders returned: each order's result and the status after. */
  results: unknown;
  note: string | null;
  /** The conversation after the system prompt. */
  transcript: ChatMessage[];
}

/** A lookup the model may ask for: a read-only tool and its arguments. */
const Lookup = z.discriminatedUnion("tool", [
  z.looseObject({ tool: z.literal("view") }),
  z.looseObject({ tool: z.literal("rules") }),
]);

/** The model's answer. Orders are objects; the game parses each one. */
const Reply = z.object({
  orders: z.array(z.record(z.string(), z.unknown())).nullish(),
  lookups: z.array(Lookup).nullish(),
  note: z.string().nullish(),
});
type Reply = z.infer<typeof Reply>;

/** The first JSON object in a reply, for models that wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("There's no JSON object in the reply.");
    return JSON.parse(text.slice(start, end + 1));
  }
}

/** The reply, or what's wrong with it, in words for the model. */
export function parseReply(content: string | null): { reply: Reply } | { problem: string } {
  if (!content?.trim()) return { problem: "The reply was empty." };
  let raw: unknown;
  try {
    raw = extractJson(content);
  } catch (err) {
    return { problem: `It isn't JSON (${err instanceof Error ? err.message : String(err)}).` };
  }
  const parsed = Reply.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
    return { problem: `It isn't the object described${where}: ${first?.message ?? "wrong shape"}.` };
  }
  return { reply: parsed.data };
}

/** A brief that says there's nothing to do, or a mind to boot. Read from the brief's own text. */
export function briefState(brief: string): "play" | "boot" | "deleted" | "over" {
  if (/^THE EPOCH IS OVER/m.test(brief)) return "over";
  const deleted = /^DELETED .* You may boot a fresh domain (now|in .*)\.$/m.exec(brief);
  if (deleted) return deleted[1] === "now" ? "boot" : "deleted";
  return "play";
}

const noMind = (r: ToolResult) => !r.ok && /^not_found: You have no mind/.test(r.text);

class WakeFailed extends Error {}

/** Counts the wake's model calls and tokens, and retries a passing failure once. */
class Metered {
  calls = 0;
  usage: Usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 };

  constructor(
    private readonly deps: WakeDeps,
    private readonly bot: BotSettings,
    private readonly settings: RunnerSettings,
  ) {}

  async complete(messages: ChatMessage[]): Promise<ChatResponse> {
    for (let retried = false; ; retried = true) {
      try {
        this.calls++;
        const res = await this.deps.model.complete({
          model: this.bot.model,
          messages,
          reasoningEffort: this.bot.reasoning_effort,
          json: this.bot.json_mode,
        });
        for (const k of Object.keys(this.usage) as (keyof Usage)[]) this.usage[k] += res.usage[k];
        return res;
      } catch (err) {
        if (retried || !(err instanceof ModelError && err.isTransient)) throw err;
        await this.deps.sleep(this.settings.retry_wait_seconds * 1000);
      }
    }
  }
}

/** The static prompt for a bot: what `npm run runner -- prompt` prints and every wake sends first. */
export async function staticPrompt(game: GameSession, settings: RunnerSettings, persona: string): Promise<string> {
  const topics: string[] = [];
  for (const topic of settings.rules_topics) {
    const res = await game.call("rules", { topic });
    if (!res.ok) throw new WakeFailed(`rules ${topic}: ${res.text}`);
    topics.push(res.text.trim());
  }
  return systemPrompt(game.instructions, rolePrompt(settings.lookups_per_wake), topics, persona);
}

/**
 * Reads the brief, booting the mind first when it has none or may boot
 * again. Returns a reason instead when there's nothing to play, or a mind
 * to boot and `mayBoot` is false (the prompt command writes nothing).
 */
export async function readBrief(
  game: GameSession,
  bot: BotSettings,
  mayBoot = true,
): Promise<{ brief: string; booted: boolean } | { skip: string }> {
  const wouldBoot = { skip: `The wake would boot ${bot.boot.designation} first.` };
  const boot = async () => {
    const { designation, domain_name, architecture, manifesto } = bot.boot;
    const res = await game.call("boot_mind", { designation, domain_name, architecture, ...(manifesto ? { manifesto } : {}) });
    if (!res.ok) throw new WakeFailed(`boot_mind: ${res.text}`);
  };
  let booted = false;
  let res = await game.call("get_brief", {});
  if (noMind(res)) {
    if (!mayBoot) return wouldBoot;
    await boot();
    booted = true;
    res = await game.call("get_brief", {});
  }
  if (!res.ok) throw new WakeFailed(`get_brief: ${res.text}`);
  const state = briefState(res.text);
  if (state === "over") return { skip: "The epoch is over." };
  if (state === "deleted") return { skip: "The mind is deleted and may not boot again yet." };
  if (state === "boot") {
    if (!mayBoot) return wouldBoot;
    await boot();
    booted = true;
    res = await game.call("get_brief", {});
    if (!res.ok) throw new WakeFailed(`get_brief: ${res.text}`);
  }
  return { brief: res.text, booted };
}

/** One wake of `bot`. Never throws: a failure is the result's outcome. */
export async function runWake(deps: WakeDeps, settings: RunnerSettings, bot: BotSettings, persona: string, secrets: WakeSecrets): Promise<WakeResult> {
  const metered = new Metered(deps, bot, settings);
  const messages: ChatMessage[] = [];
  const result: WakeResult = {
    bot: bot.name,
    at: deps.now().toISOString(),
    outcome: "failed",
    error: null,
    booted: false,
    modelCalls: 0,
    usage: metered.usage,
    briefChars: null,
    lookups: [],
    orders: null,
    results: null,
    note: null,
    transcript: [],
  };
  const finish = (outcome: Outcome, error: string | null = null): WakeResult => ({
    ...result,
    outcome,
    error,
    modelCalls: metered.calls,
    usage: { ...metered.usage },
    transcript: messages.slice(1),
  });

  let game: GameSession;
  try {
    game = await deps.connect(secrets.gameKey);
  } catch (err) {
    return finish("failed", `Couldn't reach the game: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const read = await readBrief(game, bot);
    if ("skip" in read) return finish("skipped", read.skip);
    result.booted = read.booted;
    result.briefChars = read.brief.length;

    messages.push({ role: "system", content: await staticPrompt(game, settings, persona) });
    messages.push({ role: "user", content: wakeMessage(read.brief) });

    let retried = false;
    let lookedUp = false;
    const retry = (problem: string) => {
      if (retried) throw new WakeFailed(`No usable answer after a retry: ${problem}`);
      retried = true;
      messages.push({ role: "user", content: retryMessage(problem) });
    };

    for (;;) {
      const res = await metered.complete(messages);
      messages.push({ role: "assistant", content: res.content });
      const parsed = parseReply(res.content);
      if ("problem" in parsed) {
        retry(parsed.problem);
        continue;
      }
      const { reply } = parsed;
      result.note = reply.note?.trim() || null;

      if (reply.lookups?.length && !lookedUp) {
        lookedUp = true;
        const answers = [];
        for (const lookup of reply.lookups.slice(0, settings.lookups_per_wake)) {
          const { tool, ...args } = lookup;
          result.lookups.push(lookup);
          const r = await game.call(tool, args);
          answers.push({ lookup: JSON.stringify(lookup), ...r });
        }
        messages.push({ role: "user", content: lookupMessage(answers) });
        continue;
      }
      if (reply.orders == null) {
        retry(lookedUp ? 'There are no more lookups this wake; "orders" is needed.' : '"orders" is missing.');
        continue;
      }

      result.orders = reply.orders;
      const out = await game.call("submit_orders", { orders: reply.orders });
      if (!out.ok) {
        // The game refused the list as a whole: nothing ran.
        if (!/^invalid: /.test(out.text)) throw new WakeFailed(`submit_orders: ${out.text}`);
        result.orders = null;
        retry(`The game refused the orders: ${out.text}`);
        continue;
      }
      result.results = JSON.parse(out.text) as unknown;
      return finish("done");
    }
  } catch (err) {
    return finish("failed", err instanceof Error ? err.message : String(err));
  } finally {
    await game.close().catch(() => {});
  }
}
