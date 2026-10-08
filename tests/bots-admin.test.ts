import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadRules } from "../src/config.js";
import { listedEpochs } from "../src/game/epochs.js";
import { botPage, botsOverview, changeBot, tunablesFromForm, undoChange } from "../src/game/bots.js";
import { newGame } from "../src/game/game.js";
import { skipped } from "../src/runner/service.js";
import { loadRunner } from "../src/runner/settings.js";
import { pickTunables, type RunRecord } from "../src/runner/store.js";
import type { Tunables } from "../src/runner/tunables.js";
import { MemoryStore } from "../src/store/memory.js";
import { memoryBotTables } from "../src/store/runner.js";
import { logIn, memoryLogins, ORIGIN } from "./logins.js";

// The admin's bot pages (phase 6b, src/game/bots.ts, /admin/bots): what
// they show, changing a bot's settings through the form, the change log
// and undo, and that nobody else reads or changes anything. The privacy
// crawl (tests/privacy.test.ts) covers the pages for everyone else too.

const T = Date.UTC(2026, 9, 7, 12);
const ADMIN = { account: "overseer", admin: true };
const runner = loadRunner();
const lantern = runner.bots.find((b) => b.name === "lantern")!;

function done(day: string, slot: number, tokens: number): RunRecord {
  const r = skipped("lantern", T - 60_000, "");
  return {
    bot: "lantern",
    day,
    slot,
    result: { ...r, outcome: "done", error: null, model: lantern.model, modelCalls: 1, usage: { promptTokens: tokens - 50, completionTokens: 50, reasoningTokens: 0, cachedTokens: 0 }, note: "NOTE-77", orders: [{ do: "scratchpad", text: "x" }], results: { results: [{ ok: true }] } },
  };
}

const formOf = (t: Tunables): Record<string, string> => ({
  model: t.model,
  fallback_models: t.fallback_models.join(", "),
  reasoning_effort: t.reasoning_effort,
  ...(t.json_mode ? { json_mode: "on" } : {}),
  wakes_per_day: String(t.wakes_per_day),
  window: t.window,
  daily_tokens: t.daily_tokens === null ? "" : String(t.daily_tokens),
  ...(t.paused ? { paused: "on" } : {}),
});

async function main() {
  const start = pickTunables(lantern);
  const bots = new Map([["lantern", { ...start }]]);
  const tables = memoryBotTables({ timezone: "UTC", budget: 50_000 }, bots, [done("2026-10-07", 0, 1200), done("2026-10-07", 1, 800), done("2026-10-06", 5, 999)]);

  // Nobody but the admin: not found, before anything is read or changed.
  for (const who of [{ account: "pike" }, { account: "" }]) {
    assert.ok("ok" in (await botsOverview(tables, who, T)));
    assert.ok("ok" in (await botPage(tables, who, "lantern", T)));
    assert.equal((await changeBot(tables, who, "lantern", formOf({ ...start, model: "x/y" }))).ok, false);
    assert.equal(bots.get("lantern")!.model, start.model);
  }
  // Without the runner's tables, the pages don't exist even for the admin.
  assert.ok("ok" in (await botsOverview(undefined, ADMIN, T)));

  const overview = await botsOverview(tables, ADMIN, T);
  assert.ok(!("ok" in overview));
  assert.equal(overview.day, "2026-10-07");
  assert.equal(overview.total, 2000, "today's tokens, not yesterday's");
  assert.equal(overview.bots[0]!.ran, 2);
  assert.ok(overview.bots[0]!.next! > T);

  // The form: text in, tunables out; bad input is refused with why, and nothing changes.
  assert.deepEqual(tunablesFromForm(formOf(start)), start);
  for (const [field, bad, why] of [
    ["model", "a/b:online", /bills outside the subscription/],
    ["window", "18:00-06:00", /waking window/],
    ["wakes_per_day", "0", /wakes_per_day/],
    ["daily_tokens", "-5", /daily_tokens/],
    ["reasoning_effort", "lots", /reasoning_effort/],
  ] as const) {
    const out = tunablesFromForm({ ...formOf(start), [field]: bad });
    assert.ok("ok" in out && out.code === "invalid", `${field} ${bad} is refused`);
    assert.match(out.error, why);
  }

  // A change is logged with who made it; saving the same again logs nothing.
  const next = { ...start, model: "z-ai/glm-5.2", fallback_models: ["google/gemma-4-31b-it"], daily_tokens: 100_000 };
  const changed = await changeBot(tables, ADMIN, "lantern", formOf(next));
  assert.ok(changed.ok && changed.change);
  assert.deepEqual(changed.change.changes, {
    model: { from: start.model, to: "z-ai/glm-5.2" },
    fallback_models: { from: [], to: ["google/gemma-4-31b-it"] },
    daily_tokens: { from: null, to: 100_000 },
  });
  assert.equal(changed.change.by, "overseer");
  assert.deepEqual(bots.get("lantern"), next);
  const again = await changeBot(tables, ADMIN, "lantern", formOf(next));
  assert.ok(again.ok && again.change === null);

  // Undo puts back what that change changed, as a change of its own.
  const undone = await undoChange(tables, ADMIN, "lantern", changed.change.id);
  assert.ok(undone.ok && undone.change?.undoes === changed.change.id);
  assert.deepEqual(bots.get("lantern"), start);
  assert.equal((await undoChange(tables, ADMIN, "lantern", 999)).ok, false);
  const page = await botPage(tables, ADMIN, "lantern", T);
  assert.ok(!("ok" in page));
  assert.equal(page.changes.length, 2);
  assert.equal(page.runs.length, 3);
  assert.ok("ok" in (await botPage(tables, ADMIN, "nobody", T)));

  // Through the web: the pages, the form's post and undo, a refusal shown on the page, and a 404 for anyone else.
  const logins = memoryLogins({ overseer: "overseer-password", pike: "pike-password" }, ["overseer"]);
  const app = createApp({
    epochs: listedEpochs([new MemoryStore(newGame(loadRules(), { epoch: 1, seed: 1, startedAt: T }))]),
    now: () => T,
    identify: async () => null,
    logins,
    bots: tables,
  });
  const admin = await logIn(app, "overseer", "overseer-password");
  const pike = await logIn(app, "pike", "pike-password");
  const post = (url: string, cookie: string, fields: Record<string, string>) =>
    app.request(url, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

  const list = await app.request("/admin/bots", { headers: { cookie: admin } });
  assert.equal(list.status, 200);
  const listed = await list.text();
  assert.match(listed, /href="\/admin\/bots\/lantern"/);
  assert.ok(listed.includes(start.model));
  const mine = await (await app.request("/admin/bots/lantern", { headers: { cookie: admin } })).text();
  assert.match(mine, /NOTE-77/, "a wake's note");
  assert.match(mine, /name="model" value="[^"]+"/);

  assert.equal((await post("/admin/bots/lantern", pike, formOf({ ...start, model: "x/y" }))).status, 404);
  assert.equal((await post("/admin/bots/lantern/undo", pike, { change: "1" })).status, 404);
  assert.deepEqual(bots.get("lantern"), start, "PIKE changed nothing");

  const saved = await post("/admin/bots/lantern", admin, formOf({ ...start, model: "tencent/hy3", paused: true }));
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get("location"), "/admin/bots/lantern?saved");
  assert.equal(bots.get("lantern")!.model, "tencent/hy3");
  assert.equal(bots.get("lantern")!.paused, true);
  const refused = await post("/admin/bots/lantern", admin, { ...formOf(start), window: "nonsense" });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /class="error"/);
  assert.equal(bots.get("lantern")!.model, "tencent/hy3", "a refused form changes nothing");
  const lastId = (await tables.changes("lantern", 1))[0]!.id;
  assert.equal((await post("/admin/bots/lantern/undo", admin, { change: String(lastId) })).status, 303);
  assert.equal(bots.get("lantern")!.model, start.model);
  // A post from elsewhere is refused before anything else.
  const forged = await app.request("/admin/bots/lantern", { method: "POST", headers: { cookie: admin, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(formOf({ ...start, model: "x/y" })).toString() });
  assert.equal(forged.status, 403);
  assert.equal(bots.get("lantern")!.model, start.model);

  console.log("bots admin: all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
