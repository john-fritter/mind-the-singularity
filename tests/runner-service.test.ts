import assert from "node:assert/strict";
import type { Hono } from "hono";
import { loadRules } from "../src/config.js";
import { fixedEpoch } from "../src/game/epochs.js";
import { newGame } from "../src/game/game.js";
import { createMcpApp } from "../src/mcp/app.js";
import { httpGame } from "../src/runner/mcp.js";
import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { dayOf, localTime, nextWake, wakeTimes } from "../src/runner/schedule.js";
import { RunnerService } from "../src/runner/service.js";
import { loadRunner, readPersona, type BotSettings, type RunnerSettings } from "../src/runner/settings.js";
import { MemoryRunnerStore } from "../src/runner/store.js";
import { parseWindow } from "../src/runner/tunables.js";
import { MemoryStore } from "../src/store/memory.js";

// The runner as a service (phase 6b), on a fake clock with a scripted model
// and the real MCP server: the schedule, the daily budget and each bot's
// cap, a restart mid-day, NanoGPT's daily cap on a key, fallback models, a
// change of settings taking effect on the next wake, and the epoch's end.

const rules = loadRules();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 5);
const base = loadRunner();
// The test bots, awake here though the file pauses them for the real epochs.
const lantern = { ...base.bots.find((b) => b.name === "lantern")!, paused: false };
const tally = { ...base.bots.find((b) => b.name === "tally")!, paused: false };

/** Answers every wake with one cheap order, and remembers which model it was asked for. */
class Model implements ChatModel {
  asked: string[] = [];
  /** Failures to throw for a model id, in turn. */
  fail = new Map<string, Error[]>();
  constructor(private readonly tokens = 1000) {}
  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.asked.push(req.model);
    const err = this.fail.get(req.model)?.shift();
    if (err) throw err;
    return {
      content: JSON.stringify({ orders: [{ do: "scratchpad", text: "noted" }], lookups: null, note: "ok" }),
      finishReason: "stop",
      usage: { promptTokens: this.tokens - 100, completionTokens: 100, reasoningTokens: 0, cachedTokens: 0 },
    };
  }
}

function world(settings: Partial<RunnerSettings> = {}, bots: BotSettings[] = [lantern, tally]) {
  const game = newGame(rules, { epoch: 1, seed: 5, startedAt: T0 });
  const clock = { now: T0 };
  const keys: Record<string, string> = { "key-lantern": "lantern", "key-tally": "tally" };
  const app: Hono = createMcpApp({ epochs: fixedEpoch(new MemoryStore(game)), now: () => clock.now, identify: async (k) => (keys[k] ? { account: keys[k] } : null) });
  const viaApp = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)));
  const store = new MemoryRunnerStore();
  const model = new Model();
  const s: RunnerSettings = { ...base, ...settings, bots };
  const service = (startedAt: number) =>
    new RunnerService(
      {
        store,
        settings: s,
        connect: httpGame("http://127.0.0.1/mcp", viaApp as typeof fetch),
        modelFor: () => model,
        gameKey: (b) => `key-${b.name}`,
        persona: readPersona,
        now: () => clock.now,
        sleep: async () => {},
      },
      startedAt,
    );
  return { game, clock, store, model, service };
}

/** Ticks every `step` from `from` to `to`, as the service's loop would. */
async function run(svc: RunnerService, clock: { now: number }, from: number, to: number, step = 10 * MINUTE) {
  for (clock.now = from; clock.now <= to; clock.now += step) await svc.tick(clock.now);
}

function schedule() {
  const s = { wakes_per_day: 8, window: "08:00-24:00" };
  const times = wakeTimes("lantern", s, "2026-10-07", "UTC");
  assert.equal(times.length, 8);
  const w = parseWindow(s.window)!;
  times.forEach((t, slot) => {
    const minute = (t - Date.UTC(2026, 9, 7)) / MINUTE;
    assert.ok(minute >= w.start + slot * 120 && minute < w.start + (slot + 1) * 120, `slot ${slot} falls in its part of the window`);
  });
  assert.deepEqual(wakeTimes("lantern", s, "2026-10-07", "UTC"), times, "the same every time it's asked");
  assert.notDeepEqual(wakeTimes("tally", s, "2026-10-07", "UTC"), times, "each bot has its own minutes");
  // After the last slot, the next wake is tomorrow's first.
  const late = nextWake("lantern", s, times[7]!, "UTC");
  assert.equal(late.day, "2026-10-08");
  assert.equal(late.slot, 0);
  // A timezone: Los Angeles' midnight, and 3am on the day the clocks go back.
  assert.equal(dayOf(Date.UTC(2026, 9, 7, 5), "America/Los_Angeles"), "2026-10-06");
  assert.equal(localTime("2026-10-07", 0, "America/Los_Angeles"), Date.UTC(2026, 9, 7, 7));
  assert.equal(localTime("2026-11-01", 180, "America/Los_Angeles"), Date.UTC(2026, 10, 1, 11));
  assert.equal(parseWindow("24:00-08:00"), null);
  assert.equal(parseWindow("8:00-9:30")?.end, 570);
}

async function aDay() {
  const { clock, store, model, service } = world();
  const svc = service(T0);
  assert.deepEqual(await svc.seed(), ["lantern", "tally"]);
  assert.deepEqual(await svc.seed(), [], "seeding twice adds nothing");
  await run(svc, clock, T0, T0 + DAY - 1);
  const done = (bot: string) => store.runs.filter((r) => r.bot === bot && r.result.outcome === "done");
  assert.equal(done("lantern").length, 8, "eight wakes a day");
  assert.equal(done("tally").length, 8);
  assert.deepEqual(done("lantern").map((r) => r.slot), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(done("lantern")[0]!.result.booted, "the first wake boots the mind");
  assert.equal(model.asked.length, 16);
  // Each wake ran at or after its slot's time, within a tick.
  const times = wakeTimes("lantern", lantern, "2026-10-05", "UTC");
  for (const r of done("lantern")) {
    const at = Date.parse(r.result.at);
    assert.ok(at >= times[r.slot!]! && at < times[r.slot!]! + 10 * MINUTE);
  }
  const status = await svc.status(T0 + DAY - 1);
  assert.equal(status.total, 16 * 1000);
  assert.equal(status.bots[0]!.ran, 8);
  assert.equal(status.bots[0]!.next?.day, "2026-10-06");
}

async function restart() {
  const { clock, store, service } = world();
  const first = service(T0);
  await first.seed();
  await run(first, clock, T0, T0 + 12 * HOUR);
  const before = store.runs.length;
  assert.equal(before, 8, "four slots each by noon");
  // A second runner on the same tables, started at noon: nothing repeats.
  const second = service(T0 + 12 * HOUR);
  await run(second, clock, T0 + 12 * HOUR, T0 + DAY - 1);
  const slots = store.runs.filter((r) => r.bot === "lantern").map((r) => r.slot);
  assert.deepEqual(slots, [0, 1, 2, 3, 4, 5, 6, 7], "each slot once across the restart");
  // A runner that was down from 10:00 to 16:00 misses the slots in between.
  const { clock: c2, store: s2, service: svc2 } = world();
  await svc2(T0).seed();
  await run(svc2(T0), c2, T0, T0 + 10 * HOUR);
  await run(svc2(T0 + 16 * HOUR), c2, T0 + 16 * HOUR, T0 + DAY - 1);
  const ran = s2.runs.filter((r) => r.bot === "lantern").map((r) => r.slot);
  const times = wakeTimes("lantern", lantern, "2026-10-05", "UTC");
  const whileDown = times.flatMap((t, slot) => (t > T0 + 10 * HOUR && t < T0 + 16 * HOUR ? [slot] : []));
  assert.ok(whileDown.length > 0);
  for (const slot of whileDown) assert.ok(!ran.includes(slot), `slot ${slot}, due while the runner was down, isn't caught up`);
  assert.ok(ran.includes(7));
}

async function budgets() {
  // The runner's budget: 3,000 tokens a day is three wakes.
  const { clock, store, model, service } = world({ daily_token_budget: 3000 });
  const svc = service(T0);
  await svc.seed();
  await run(svc, clock, T0, T0 + DAY - 1);
  assert.equal(store.runs.filter((r) => r.result.outcome === "done").length, 3);
  const skipped = store.runs.filter((r) => r.result.outcome === "skipped");
  assert.equal(skipped.length, 13, "the rest are skipped, slot by slot");
  assert.match(skipped[0]!.result.error!, /daily budget is spent/);
  assert.equal(model.asked.length, 3, "a skip calls no model");
  // The next day it resets.
  await run(svc, clock, T0 + DAY, T0 + DAY + 6 * HOUR);
  assert.ok(store.runs.some((r) => r.day === "2026-10-06" && r.result.outcome === "done"));

  // A bot's own cap: Lantern may spend 2,000 a day; Tally isn't capped.
  const w = world();
  const s = w.service(T0);
  await s.seed();
  w.store.bots.get("lantern")!.daily_tokens = 2000;
  await run(s, w.clock, T0, T0 + DAY - 1);
  const mine = w.store.runs.filter((r) => r.bot === "lantern");
  assert.equal(mine.filter((r) => r.result.outcome === "done").length, 2);
  assert.match(mine.find((r) => r.result.outcome === "skipped")!.result.error!, /Its daily cap is spent/);
  assert.equal(w.store.runs.filter((r) => r.bot === "tally" && r.result.outcome === "done").length, 8);
}

async function dailyCap() {
  // Lantern's key hits NanoGPT's daily cap: Lantern skips until midnight; Tally, on another key, plays on.
  const tallyOwnKey = { ...tally, model_key_env: "NANOGPT_KEY_TALLY" };
  const { clock, store, model, service } = world({}, [lantern, tallyOwnKey]);
  const svc = service(T0);
  await svc.seed();
  model.fail.set(lantern.model, [new ModelError("NanoGPT 429: daily", 429, "daily_rpd_limit_exceeded")]);
  await run(svc, clock, T0, T0 + DAY - 1);
  const mine = store.runs.filter((r) => r.bot === "lantern");
  assert.equal(mine[0]!.result.outcome, "failed");
  assert.ok(mine[0]!.result.dailyCap);
  assert.ok(mine.slice(1).every((r) => r.result.outcome === "skipped" && /NanoGPT's daily cap/.test(r.result.error!)));
  assert.equal(store.runs.filter((r) => r.bot === "tally" && r.result.outcome === "done").length, 8);
  await run(svc, clock, T0 + DAY, T0 + DAY + 6 * HOUR);
  assert.ok(store.runs.some((r) => r.bot === "lantern" && r.day === "2026-10-06" && r.result.outcome === "done"), "the cap lifts at midnight");
}

async function fallbacksAndChanges() {
  const { clock, store, model, service } = world({}, [lantern]);
  const svc = service(T0);
  await svc.seed();
  const t = store.bots.get("lantern")!;
  t.fallback_models = ["backup/one", "backup/two"];
  const busy = () => new ModelError("NanoGPT 502: upstream request failed", 502, null);
  model.fail.set(t.model, [busy(), busy()]);
  model.fail.set("backup/one", [busy()]);
  await run(svc, clock, T0, wakeTimes("lantern", t, "2026-10-05", "UTC")[0]! + 10 * MINUTE);
  const first = store.runs[0]!.result;
  assert.equal(first.outcome, "done");
  assert.equal(first.model, "backup/two", "the second fallback answered");
  assert.deepEqual(model.asked, [t.model, t.model, "backup/one", "backup/two"], "own model twice, then each fallback once");

  // The admin changes the model: the next wake uses it, with no restart.
  t.model = "z-ai/glm-5.2";
  t.fallback_models = [];
  model.asked = [];
  const second = wakeTimes("lantern", t, "2026-10-05", "UTC")[1]!;
  await run(svc, clock, clock.now, second + 10 * MINUTE);
  assert.deepEqual(model.asked, ["z-ai/glm-5.2"]);
  // Paused: no wakes, and none recorded.
  t.paused = true;
  const runs = store.runs.length;
  await run(svc, clock, clock.now, T0 + DAY - 1);
  assert.equal(store.runs.length, runs);
}

async function epochOver() {
  const { game, clock, store, model, service } = world({}, [lantern]);
  const svc = service(T0);
  await svc.seed();
  const first = wakeTimes("lantern", lantern, "2026-10-05", "UTC")[0]!;
  await run(svc, clock, T0, first + 10 * MINUTE);
  assert.equal(store.runs.length, 1);
  game.world.ended = { at: clock.now, outcome: "shutdown", ascended: [] };
  model.asked = [];
  await run(svc, clock, clock.now, T0 + DAY - 1);
  const after = store.runs.slice(1);
  assert.ok(after.length > 0 && after.every((r) => r.result.outcome === "skipped" && r.result.error === "The epoch is over."), "an epoch that's over is skipped");
  assert.equal(model.asked.length, 0, "with no model call");
}

async function main() {
  schedule();
  await aDay();
  await restart();
  await budgets();
  await dailyCap();
  await fallbacksAndChanges();
  await epochOver();
  console.log("runner service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
