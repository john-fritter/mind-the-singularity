import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadPlayers, loadRules } from "../src/config.js";
import { ModelError, type ChatModel, type ChatResponse } from "../src/runner/model.js";
import { loadRunner, readPersona } from "../src/runner/settings.js";
import { readSave } from "../src/store/save.js";
import { runWeek, wakeAt, type WeekOptions } from "../src/week/week.js";

// The simulated week (phase 3e) with a scripted model: the bot plays
// through the real MCP server on a loopback port, the scripted players take
// their wakes between its own, every brief is measured, and a run stopped
// by a failed model call resumes to the same game as one that never stopped.

const rules = loadRules();
const players = loadPlayers();
const runner = loadRunner();
const week = runner.week!;
const bot = runner.bots.find((b) => b.name === week.bot)!;
const persona = readPersona(bot);
// No waiting between retries.
const quick = { ...runner, retry_wait_seconds: 0 };

const options: WeekOptions = { ...week, days: 1, wakes_per_day: 4, startedAt: Date.UTC(2026, 9, 5) };

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

const deps = (model: ChatModel) => ({ model, sleep: async () => {}, log: () => {} });
const input = (dir: string, resume = false) => ({ rules, players, runner: quick, bot, persona, options, dir, resume });

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "week-"));
  try {
    // Wake times: one in each slot, the same for the same seed.
    const slot = 86_400_000 / options.wakes_per_day;
    for (let k = 0; k < 4; k++) {
      const at = wakeAt(options, k);
      assert.ok(at >= options.startedAt + k * slot && at < options.startedAt + (k + 1) * slot, `wake ${k} is inside its slot`);
      assert.equal(at % 60_000, 0, "on a whole minute");
    }

    // A straight run.
    const straight = path.join(root, "straight");
    const out = await runWeek(deps(new Scripted()), input(straight));
    assert.ok(out.finished);
    assert.deepEqual(out.problems, []);
    assert.equal(out.wakes.length, 4);
    assert.ok(out.wakes.every((w) => w.outcome === "done"), out.wakes.map((w) => w.error).join("; "));
    assert.ok(out.wakes[0]!.booted, "the first wake boots the bot's mind");
    for (const w of out.wakes) assert.ok(w.briefTokens !== null && w.briefTokens > 0 && w.briefTokens <= week.brief_ceiling_tokens);
    assert.match(out.report, /Orders: 4 of 4 accepted/);
    assert.match(out.report, /rebuilds exactly/);
    assert.equal(readFileSync(path.join(straight, "report.md"), "utf-8"), out.report);

    const save = readSave(path.join(straight, "game.json"));
    assert.equal(save.clock, options.startedAt + 86_400_000, "the save's clock is at the week's end");
    for (const p of save.players) assert.ok(save.game.owners.some((o) => o.account === p.account), `${p.boot.designation} booted on its first wake`);
    assert.ok(save.game.owners.some((o) => o.account === bot.name));
    assert.ok(save.game.log.filter((e) => e.account === bot.name && e.kind === "orders").length === 4, "one batch of orders a wake");
    const scripted = save.game.log.filter((e) => e.account.startsWith("bot:") && e.kind === "orders").length;
    assert.ok(scripted > 0, "the scripted players played");

    // Stopped by the model on the third wake, then resumed.
    const stopped = path.join(root, "stopped");
    const first = await runWeek(deps(new Scripted(3)), input(stopped));
    assert.equal(first.finished, false);
    assert.equal(first.wakes.length, 2, "the failed wake isn't counted");
    const resumed = await runWeek(deps(new Scripted()), input(stopped, true));
    assert.ok(resumed.finished);
    assert.equal(resumed.wakes.length, 4);
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
