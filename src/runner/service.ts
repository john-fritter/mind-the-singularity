import type { ConnectGame } from "./mcp.js";
import type { ChatModel } from "./model.js";
import { dayOf, nextMidnight, nextWake, wakeTimes, type Day } from "./schedule.js";
import { withTunables, type BotSettings, type RunnerSettings } from "./settings.js";
import { spentBy, type RunRecord, type RunnerStore } from "./store.js";
import type { Tunables } from "./tunables.js";
import { runWake, type WakeResult } from "./wake.js";

/**
 * The runner as a service (`npm run runner -- serve`, phase 6b). Each tick
 * it reads every bot's tunables from the database (so the admin's changes
 * take effect on the next wake) and today's runs, then wakes each bot whose
 * slot has come due, one at a time, through the same runWake as a wake by
 * hand. Before a wake it checks, in order: the runner's daily token budget,
 * the bot's own daily cap, and whether the bot's NanoGPT key is at
 * NanoGPT's daily cap; a wake that can't run is recorded as skipped, with
 * why, so its slot counts as taken. Both budgets reset at midnight in the
 * runner's timezone.
 */

export interface ServiceDeps {
  store: RunnerStore;
  settings: RunnerSettings;
  connect: ConnectGame;
  /** The model client for a bot (its NanoGPT key). */
  modelFor(bot: BotSettings): ChatModel;
  /** The bot's game key, from runner.env. */
  gameKey(bot: BotSettings): string;
  persona(bot: BotSettings): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A wake that didn't run, as the runner records it. */
export function skipped(bot: string, at: number, why: string): WakeResult {
  return {
    bot,
    at: new Date(at).toISOString(),
    outcome: "skipped",
    error: why,
    booted: false,
    modelCalls: 0,
    model: null,
    dailyCap: false,
    usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
    briefChars: null,
    lookups: [],
    orders: null,
    results: null,
    note: null,
    transcript: [],
  };
}

export interface BotStatus {
  name: string;
  tunables: Tunables | null;
  spent: number;
  /** Slots run or skipped today. */
  ran: number;
  next: { day: Day; slot: number; at: number } | null;
}

export class RunnerService {
  /** NanoGPT keys (by their runner.env name) at their daily cap, and when it resets. */
  private keyCapped = new Map<string, number>();

  /** `startedAt`: when the service started; no slot due before it runs. */
  constructor(
    private readonly deps: ServiceDeps,
    private readonly startedAt: number,
  ) {}

  /** Adds the file's bots missing from the database. Returns the names added. */
  seed(): Promise<string[]> {
    return this.deps.store.seed(this.deps.settings.bots);
  }

  /**
   * Runs every wake due by `now`, one at a time. `stopping` is asked between
   * wakes, so a stop finishes the wake in hand and starts no other.
   */
  async tick(now: number, stopping: () => boolean = () => false): Promise<RunRecord[]> {
    const { store, settings } = this.deps;
    const tz = settings.timezone;
    const day = dayOf(now, tz);
    const [tunables, tally] = await Promise.all([store.tunables(), store.tally(day)]);
    let total = [...tally.spent.values()].reduce((a, b) => a + b, 0);
    const out: RunRecord[] = [];

    for (const file of settings.bots) {
      if (stopping()) break;
      const t = tunables.get(file.name);
      if (!t || t.paused) continue;
      const bot = withTunables(file, t);
      const done = tally.slots.get(bot.name) ?? new Set<number>();
      const due = wakeTimes(bot.name, t, day, tz)
        .map((at, slot) => ({ at, slot }))
        .filter((s) => s.at <= now && s.at >= this.startedAt && !done.has(s.slot));
      if (due.length === 0) continue;

      const record = async (slot: number, result: WakeResult) => {
        const run = { bot: bot.name, day, slot, result };
        await store.record(run);
        out.push(run);
      };
      // Slots passed over while another wake ran are missed, not caught up.
      for (const s of due.slice(0, -1)) await record(s.slot, skipped(bot.name, now, "Missed: a later slot came due first."));
      const { slot } = due.at(-1)!;

      const spent = tally.spent.get(bot.name) ?? 0;
      const capped = this.keyCapped.get(bot.model_key_env);
      if (total >= settings.daily_token_budget) {
        await record(slot, skipped(bot.name, now, `The runner's daily budget is spent (${total} of ${settings.daily_token_budget} tokens).`));
        continue;
      }
      if (t.daily_tokens !== null && spent >= t.daily_tokens) {
        await record(slot, skipped(bot.name, now, `Its daily cap is spent (${spent} of ${t.daily_tokens} tokens).`));
        continue;
      }
      if (capped !== undefined && capped > now) {
        await record(slot, skipped(bot.name, now, `${bot.model_key_env} is at NanoGPT's daily cap until ${new Date(capped).toISOString()}.`));
        continue;
      }

      const result = await runWake(
        {
          connect: this.deps.connect,
          model: this.deps.modelFor(bot),
          now: () => new Date(this.deps.now()),
          sleep: this.deps.sleep,
        },
        settings,
        bot,
        this.deps.persona(bot),
        { gameKey: this.deps.gameKey(bot) },
      );
      await record(slot, result);
      total += spentBy(result);
      tally.spent.set(bot.name, spent + spentBy(result));
      if (result.dailyCap) this.keyCapped.set(bot.model_key_env, nextMidnight(this.deps.now(), tz));
    }
    return out;
  }

  /** Each bot's settings, today's spend and its next wake: `runner -- status`. */
  async status(now: number): Promise<{ day: Day; total: number; budget: number; bots: BotStatus[] }> {
    const { store, settings } = this.deps;
    const day = dayOf(now, settings.timezone);
    const [tunables, tally] = await Promise.all([store.tunables(), store.tally(day)]);
    const bots = settings.bots.map((b): BotStatus => {
      const t = tunables.get(b.name) ?? null;
      const done = tally.slots.get(b.name) ?? new Set<number>();
      return {
        name: b.name,
        tunables: t,
        spent: tally.spent.get(b.name) ?? 0,
        ran: done.size,
        next: t && !t.paused ? nextWake(b.name, t, now, settings.timezone, done) : null,
      };
    });
    return { day, total: [...tally.spent.values()].reduce((a, c) => a + c, 0), budget: settings.daily_token_budget, bots };
  }
}
