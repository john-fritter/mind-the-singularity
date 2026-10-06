import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadPlayers, loadRules } from "../src/config.js";
import { ModelError, type ChatModel, type ChatResponse } from "../src/runner/model.js";
import { loadRunner, readPersona } from "../src/runner/settings.js";
import { readSave } from "../src/store/save.js";
import { runWeek, schedule, wakeAt, type WeekOptions } from "../src/week/week.js";

// The simulated week (phase 3e, two bots since 4e) with a scripted model:
// the bots play through the real MCP server on a loopback port, each with
// its own key, in time order; the scripted players take their wakes between
// theirs, every brief is measured, and a run stopped by a failed model call
// resumes to the same game as one that never stopped.

const rules = loadRules();
const players = loadPlayers();
const runner = loadRunner();
const week = runner.week!;
const bots = week.bots.map((name) => runner.bots.find((b) => b.name === name)!).map((bot) => ({ bot, persona: readPersona(bot) }));
// No waiting between retries.
const quick = { ...runner, retry_wait_seconds: 0 };

const options: WeekOptions = { ...week, days: 1, wakes_per_day: 4, startedAt: Date.UTC(2026, 9, 5) };
const WAKES = options.wakes_per_day * bots.length;

const ANSWER = JSON.stringify({ orders: [{ do: "scratchpad", text: "Holding steady." }], lookups: null, note: "Kept the lights on." });

/** Answers every wake the same, or fails from call `failFrom` on. */
class Scripted implements ChatModel {
  calls = 0;
  constructor(private readonly failFrom = Infinity) {}
  async complete(): Promise<ChatResponse> {
    this.calls++;
    if (this.calls >= this.failFrom) throw new ModelError("Service unavailable", 503, null);
    return { content: ANSWER, finishReason: "stop", usage: { promptTokens: 6000, completionTokens: 50, reasoningTokens: 0, cachedTokens: 0 } };
  }
}

const deps = (model: ChatModel) => ({ model: () => model, sleep: async () => {}, log: () => {} });
const input = (dir: string, resume = false) => ({ rules, players, runner: quick, bots, options, dir, resume });

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "week-"));
  try {
    assert.ok(bots.length >= 2, "the week plays two bots");
    // Wake times: one in each slot for each bot, the same for the same seed, all in time order.
    const slot = 86_400_000 / options.wakes_per_day;
    for (let b = 0; b < bots.length; b++) {
      for (let k = 0; k < 4; k++) {
        const at = wakeAt(options, k, b);
        assert.ok(at >= options.startedAt + k * slot && at < options.startedAt + (k + 1) * slot, `wake ${k} is inside its slot`);
        assert.equal(at % 60_000, 0, "on a whole minute");
      }
    }
    const plan = schedule(options);
    assert.equal(plan.length, WAKES);
    assert.ok(plan.every((p, i) => i === 0 || plan[i - 1]!.at <= p.at), "in time order");
    assert.notDeepEqual(plan.filter((p) => p.bot === 0).map((p) => p.at), plan.filter((p) => p.bot === 1).map((p) => p.at), "each bot has its own times");

    // A straight run.
    const straight = path.join(root, "straight");
    const out = await runWeek(deps(new Scripted()), input(straight));
    assert.ok(out.finished);
    assert.deepEqual(out.problems, []);
    assert.equal(out.wakes.length, WAKES);
    assert.ok(out.wakes.every((w) => w.outcome === "done"), out.wakes.map((w) => w.error).join("; "));
    for (const { bot } of bots) {
      const mine = out.wakes.filter((w) => w.bot === bot.name);
      assert.equal(mine.length, 4);
      assert.ok(mine[0]!.booted, "the first wake boots the bot's mind");
    }
    for (const w of out.wakes) assert.ok(w.briefTokens !== null && w.briefTokens > 0 && w.briefTokens <= week.brief_ceiling_tokens);
    assert.equal(out.report.match(/Orders: 4 of 4 accepted/g)?.length, bots.length);
    assert.match(out.report, /rebuilds exactly/);
    assert.match(out.report, /^- A bot traded: NO\.$/m, "the scripted model doesn't trade");
    assert.match(out.report, /^## Conquest and raids$/m);
    assert.equal(readFileSync(path.join(straight, "report.md"), "utf-8"), out.report);

    const save = readSave(path.join(straight, "game.json"));
    assert.equal(save.clock, options.startedAt + 86_400_000, "the save's clock is at the week's end");
    for (const p of save.players) assert.ok(save.game.owners.some((o) => o.account === p.account), `${p.boot.designation} booted on its first wake`);
    for (const { bot } of bots) {
      assert.ok(save.game.owners.some((o) => o.account === bot.name));
      assert.ok(save.game.log.filter((e) => e.account === bot.name && e.kind === "orders").length === 4, "one batch of orders a wake");
    }
    const scripted = save.game.log.filter((e) => e.account.startsWith("bot:") && e.kind === "orders").length;
    assert.ok(scripted > 0, "the scripted players played");

    // Stopped by the model on the third wake, then resumed.
    const stopped = path.join(root, "stopped");
    const first = await runWeek(deps(new Scripted(3)), input(stopped));
    assert.equal(first.finished, false);
    assert.equal(first.wakes.length, 2, "the failed wake isn't counted");
    const resumed = await runWeek(deps(new Scripted()), input(stopped, true));
    assert.ok(resumed.finished);
    assert.equal(resumed.wakes.length, WAKES);
    const again = readSave(path.join(stopped, "game.json"));
    assert.ok(isDeepStrictEqual(again.game.world, save.game.world), "a resumed week ends where a straight one does");
    assert.ok(isDeepStrictEqual(again.game.log, save.game.log));

    await assert.rejects(runWeek(deps(new Scripted()), input(path.join(root, "none"), true)), /no week to resume/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("week tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
