import { ModelError, type ChatMessage, type ChatModel, type ReasoningEffort } from "./model.js";

/**
 * The capability probe's checks, from Fritter Board's: is a model on
 * NanoGPT's subscription URL, does reasoning_effort change how much it
 * reasons, and does it answer in JSON mode. Each check is a real request.
 * Whether it plays the game is the other half of `npm run probe`, two
 * wakes in a throwaway game (scripts/probe.ts).
 */

const PUZZLE =
  "A ferry leaves every 40 minutes from 6:10am. A second ferry leaves every 25 minutes from 6:00am. When do they next leave at the same minute after 6:10am? Answer with the time only.";

export interface ProbeChecks {
  model: string;
  reachable: string;
  /** The effort the game wakes should use: "low", or "default" for a model that refuses the parameter. */
  effort: ReasoningEffort;
  reasoning: string;
  json: string;
  /** Whether JSON mode answered cleanly. */
  jsonMode: boolean;
}

function why(err: unknown): string {
  if (err instanceof ModelError) return err.status ? `error ${err.status}${err.code ? ` ${err.code}` : ""}` : "unreachable";
  return err instanceof Error ? err.message.slice(0, 80) : String(err);
}

export const isReachable = (r: ProbeChecks) => r.reachable.startsWith("yes");

export async function probeChecks(chat: ChatModel, model: string, now: () => number = Date.now): Promise<ProbeChecks> {
  const r: ProbeChecks = { model, reachable: "no", effort: "low", reasoning: "-", json: "-", jsonMode: false };
  const ask = (messages: ChatMessage[], effort: ReasoningEffort = r.effort, json = false) =>
    chat.complete({ model, messages, reasoningEffort: effort, json });
  const ready: ChatMessage[] = [{ role: "user", content: "Reply with the single word: ready." }];

  let started = now();
  try {
    let res;
    try {
      res = await ask(ready);
    } catch (err) {
      if (!(err instanceof ModelError && err.isUnsupportedEffort)) throw err;
      r.effort = "default";
      started = now();
      res = await ask(ready);
    }
    r.reachable = `yes, ${((now() - started) / 1000).toFixed(1)}s`;
    if (r.effort === "default") r.reachable += " (refuses reasoning_effort)";
    if (!res.content?.trim()) r.reachable += " (empty reply)";
  } catch (err) {
    r.reachable = `no: ${why(err)}`;
    return r;
  }

  if (r.effort === "default") {
    r.reasoning = "refuses reasoning_effort";
  } else {
    try {
      const low = (await ask([{ role: "user", content: PUZZLE }], "low")).usage.reasoningTokens;
      const high = (await ask([{ role: "user", content: PUZZLE }], "high")).usage.reasoningTokens;
      r.reasoning =
        low === 0 && high === 0 ? "no reasoning tokens reported" : high > low * 1.5 ? `honored (low ${low}, high ${high})` : `unclear (low ${low}, high ${high})`;
    } catch (err) {
      r.reasoning = `failed: ${why(err)}`;
    }
  }

  try {
    const res = await ask([{ role: "user", content: 'What is 17 + 25? Answer with only a JSON object like {"answer": 0}.' }], r.effort, true);
    const parsed = JSON.parse(res.content ?? "") as { answer?: unknown };
    r.jsonMode = parsed.answer === 42;
    r.json = r.jsonMode ? "yes" : "wrong answer or shape";
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Not clean JSON: the wake can still take the object out of the prose.
      r.json = "not clean JSON";
    } else {
      r.json = `refuses JSON mode: ${why(err)}`;
    }
  }
  return r;
}
