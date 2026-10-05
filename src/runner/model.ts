/**
 * The runner's view of a chat model: OpenAI-style chat completions, as
 * NanoGPT serves them. Adapted from Fritter Board's runner, without tool
 * calling: a wake here is single-shot, the reply one JSON object. The wake
 * depends on this interface, so tests can script a model without a network.
 */

/** "default" sends no reasoning_effort at all, for models that refuse the parameter. */
export type ReasoningEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const REASONING_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh"] as const;

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

  /** Worth one retry: rate limiting other than the daily cap, server errors, timeouts, network. */
  get isTransient(): boolean {
    if (this.isDailyCap) return false;
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

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
 * NanoGPT's chat completions, on the subscription base URL. The runner never
 * sends provider selection or billing overrides: those bypass the
 * subscription and bill pay-as-you-go.
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
      stream: false,
      include_usage: true,
      max_tokens: this.opts.maxOutputTokens,
    };
    if (req.reasoningEffort !== "default") {
      body["reasoning_effort"] = req.reasoningEffort;
      // Reasoning is still billed; this only keeps its text out of the reply.
      body["reasoning"] = { exclude: true };
    }
    if (req.json) body["response_format"] = { type: "json_object" };

    const timeout = AbortSignal.timeout(this.opts.timeoutSeconds * 1000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const what = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "couldn't be reached";
      throw new ModelError(`The model ${what}: ${err instanceof Error ? err.message : String(err)}`, null, null);
    }

    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (json?.["error"] ?? {}) as Record<string, unknown>;
      const message =
        (typeof e["message"] === "string" && e["message"]) ||
        (typeof json?.["message"] === "string" && json["message"]) ||
        text.slice(0, 300) ||
        res.statusText;
      throw new ModelError(`NanoGPT ${res.status}: ${message}`, res.status, typeof e["code"] === "string" ? e["code"] : null);
    }
    if (!json) throw new ModelError("NanoGPT sent something that isn't JSON.", res.status, null);

    const choice = ((json["choices"] as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined;
    const message = (choice?.["message"] ?? {}) as Record<string, unknown>;
    return {
      content: typeof message["content"] === "string" ? message["content"] : null,
      finishReason: typeof choice?.["finish_reason"] === "string" ? choice["finish_reason"] : null,
      usage: parseUsage(json["usage"]),
    };
  }
}
