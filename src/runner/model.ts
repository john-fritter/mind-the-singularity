/**
 * The runner's view of a chat model: OpenAI-style chat completions, as
 * NanoGPT serves them. Adapted from Fritter Board's runner, without tool
 * calling: a wake here is single-shot, the reply one JSON object. The wake
 * depends on this interface, so tests can script a model without a network.
 */

import type { ReasoningEffort } from "./tunables.js";

export { modelIdProblem, REASONING_EFFORTS, type ReasoningEffort } from "./tunables.js";

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  /** Ask for a JSON object as the reply (response_format json_object). */
  json: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface ChatResponse {
  content: string | null;
  finishReason: string | null;
  usage: Usage;
}

export interface ChatModel {
  complete(req: ChatRequest): Promise<ChatResponse>;
}

/** A model call that failed. `code` is NanoGPT's error code when it gave one. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ModelError";
  }

  /** The key's requests-per-day (or dollars-per-day) cap: nothing to do until it resets. */
  get isDailyCap(): boolean {
    return this.status === 429 && (this.code === "daily_rpd_limit_exceeded" || this.code === "daily_usd_limit_exceeded");
  }

  /** The model won't take a reasoning_effort: give the bot "default", which sends none. */
  get isUnsupportedEffort(): boolean {
    return this.status === 400 && this.code === "unsupported_reasoning_effort";
  }

  /** Worth one retry: rate limiting other than the daily cap, server errors, timeouts, network. */
  get isTransient(): boolean {
    if (this.isDailyCap) return false;
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Reads token counts from whichever of NanoGPT's usage fields are present. */
export function parseUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const completionDetails = (u["completion_tokens_details"] ?? {}) as Record<string, unknown>;
  const promptDetails = (u["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  return {
    promptTokens: num(u["prompt_tokens"]),
    completionTokens: num(u["completion_tokens"]),
    reasoningTokens: num(u["reasoning_tokens"]) || num(completionDetails["reasoning_tokens"]),
    cachedTokens: num(promptDetails["cached_tokens"]) || num(u["cache_read_input_tokens"]),
  };
}

export interface NanoGptOptions {
  baseUrl: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
  fetch?: typeof fetch;
}

/**
 * NanoGPT's chat completions, on the subscription base URL, streamed. A
 * non-streamed call that runs past about 30 seconds comes back as a 502
 * ("upstream request failed"): every model the 6b probe tried did that on a
 * real wake with any reasoning_effort set, as reasoning over a 7,000-token
 * prompt takes longer. Streaming keeps the connection busy, so only the
 * runner's own timeout applies. The runner never sends provider selection
 * or billing overrides: those bypass the subscription and bill
 * pay-as-you-go.
 */
export class NanoGptModel implements ChatModel {
  constructor(
    private readonly apiKey: string,
    private readonly opts: NanoGptOptions,
  ) {}

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.opts.maxOutputTokens,
    };
    // The reasoning's text streams in its own deltas, which are dropped
    // here. It isn't excluded: with it excluded, nothing streams while the
    // model reasons, and a long think hits the same 30-second cutoff.
    if (req.reasoningEffort !== "default") body["reasoning_effort"] = req.reasoningEffort;
    if (req.json) body["response_format"] = { type: "json_object" };

    const timeout = AbortSignal.timeout(this.opts.timeoutSeconds * 1000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const unreachable = (err: unknown) => {
      const what = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timed out" : "couldn't be reached";
      return new ModelError(`The model ${what}: ${err instanceof Error ? err.message : String(err)}`, null, null);
    };
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw unreachable(err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = null;
      }
      const e = (json?.["error"] ?? {}) as Record<string, unknown>;
      const message =
        (typeof e["message"] === "string" && e["message"]) ||
        (typeof json?.["message"] === "string" && json["message"]) ||
        text.slice(0, 300) ||
        res.statusText;
      throw new ModelError(`NanoGPT ${res.status}: ${message}`, res.status, typeof e["code"] === "string" ? e["code"] : null);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw unreachable(err);
    }
    return parseStream(text, res.status);
  }
}

/**
 * A streamed reply, whole: the content's pieces joined, the last finish
 * reason, and the usage from the chunk that carries it. A reply that isn't
 * an event stream is read as a plain completion, as some providers answer.
 */
export function parseStream(text: string, status: number): ChatResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new ModelError("NanoGPT sent something that isn't JSON.", status, null);
    }
    const choice = ((json["choices"] as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined;
    const message = (choice?.["message"] ?? {}) as Record<string, unknown>;
    return {
      content: typeof message["content"] === "string" ? message["content"] : null,
      finishReason: typeof choice?.["finish_reason"] === "string" ? choice["finish_reason"] : null,
      usage: parseUsage(json["usage"]),
    };
  }
  let content = "";
  let any = false;
  let finishReason: string | null = null;
  let usage: Usage = parseUsage(null);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (chunk["error"]) {
      const e = chunk["error"] as Record<string, unknown>;
      // A failure mid-stream: worth the retry, as a 5xx is.
      throw new ModelError(`NanoGPT stream: ${typeof e["message"] === "string" ? e["message"] : JSON.stringify(e).slice(0, 200)}`, 502, typeof e["code"] === "string" ? e["code"] : null);
    }
    const choice = ((chunk["choices"] as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined;
    const delta = (choice?.["delta"] ?? {}) as Record<string, unknown>;
    if (typeof delta["content"] === "string") {
      content += delta["content"];
      any = true;
    }
    if (typeof choice?.["finish_reason"] === "string") finishReason = choice["finish_reason"];
    if (chunk["usage"]) usage = parseUsage(chunk["usage"]);
  }
  // Nothing at all came back: a provider's hiccup, worth the retry, as a 5xx is.
  if (!any && finishReason === null && usage.promptTokens === 0 && usage.completionTokens === 0) {
    throw new ModelError("NanoGPT sent an empty stream.", 502, null);
  }
  return { content: any ? content : null, finishReason, usage };
}
