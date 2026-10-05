import assert from "node:assert/strict";
import type { Hono } from "hono";
import { loadRules } from "../src/config.js";
import { fixedEpoch } from "../src/game/epochs.js";
import { newGame } from "../src/game/game.js";
import { TOPICS } from "../src/game/topics.js";
import { createMcpApp } from "../src/mcp/app.js";
import { httpGame, type ConnectGame } from "../src/runner/mcp.js";
import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { loadRunner, parseRunner, readPersona } from "../src/runner/settings.js";
import { briefState, parseReply, readBrief, runWake, type WakeDeps } from "../src/runner/wake.js";
import { MemoryStore } from "../src/store/memory.js";

// The runner core (phase 3d): one wake of one bot through the real MCP
// server, on a memory store, with a scripted model and no network. A wake
// boots the mind when it has none, sends the static prompt first and the
// brief last, offers one lookup round, submits the orders, and gives a bad
// answer one retry with the error.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const HOUR = 3_600_000;
const URL_ = "http://127.0.0.1/mcp";
const KEY = "key-lantern";

const settings = loadRunner();
const bot = settings.bots.find((b) => b.name === "lantern")!;
const persona = readPersona(bot);

/** A model that answers from a script, and remembers what it was asked. */
class ScriptedModel implements ChatModel {
  requests: ChatRequest[] = [];
  constructor(private readonly script: (string | Error)[]) {}
  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const next = this.script.shift();
    if (next === undefined) throw new Error("The script ran out.");
    if (next instanceof Error) throw next;
    return { content: next, finishReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, reasoningTokens: 0, cachedTokens: 600 } };
  }
}

function setup() {
  const game = newGame(rules, { epoch: 1, seed: 7, startedAt: T0 });
  const clock = { now: T0 };
  const app: Hono = createMcpApp({
    epochs: fixedEpoch(new MemoryStore(game)),
    now: () => clock.now,
    identify: async (k) => (k === KEY ? { account: "lantern" } : null),
  });
  const viaApp = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)));
  const connect = httpGame(URL_, viaApp as typeof fetch);
  const ordersLogged = () => game.log.filter((e) => e.kind === "orders").length;
  return { game, clock, connect, ordersLogged };
}

function deps(connect: ConnectGame, model: ChatModel, sleeps: number[] = []): WakeDeps {
  return { connect, model, now: () => new Date(T0), sleep: async (ms) => void sleeps.push(ms) };
}

const reply = (o: unknown) => JSON.stringify(o);

async function bootAndOrders() {
  const { game, connect, clock, ordersLogged } = setup();

  // Reading the brief for the prompt command never boots.
  const session = await connect(KEY);
  assert.deepEqual(await readBrief(session, bot, false), { skip: "The wake would boot LANTERN first." });
  await session.close();
  assert.ok(!game.owners.some((o) => o.account === "lantern"), "no mind booted");

  const model = new ScriptedModel([
    reply({ orders: [{ do: "scratchpad", text: "Day one. Build." }, { do: "expand", cycles: 2 }, { do: "bogus" }], lookups: null, note: "Grew." }),
  ]);
  const r = await runWake(deps(connect, model), settings, bot, persona, { gameKey: KEY });
  assert.equal(r.outcome, "done", r.error ?? "");
  assert.ok(r.booted, "a mind with no domain boots first");
  assert.equal(r.modelCalls, 1);
  assert.equal(r.usage.promptTokens, 1000);
  assert.equal(r.note, "Grew.");
  const results = (r.results as { results: { ok: boolean }[] }).results;
  assert.deepEqual(
    results.map((x) => x.ok),
    [true, true, false],
    "each order succeeds or fails on its own",
  );
  assert.equal(ordersLogged(), 1);

  // The prompt: the game's instructions, the role, every rules topic, the persona last; the brief in the message after.
  const req = model.requests[0]!;
  assert.equal(req.model, bot.model);
  assert.equal(req.json, true);
  const [system, user] = req.messages;
  assert.equal(system?.role, "system");
  const s = system!.content!;
  const at = (needle: string) => {
    const i = s.indexOf(needle);
    assert.ok(i >= 0, `the system prompt has ${needle}`);
    return i;
  };
  assert.ok(at("## The game") < at("## How you play") && at("## How you play") < at("## The rules") && at("## The rules") < at("## Who you are"));
  for (const t of settings.rules_topics) at(`# ${t}\n`);
  assert.ok(s.endsWith(persona), "the persona ends the static prompt");
  assert.ok(!s.includes("YOU: LANTERN"), "no brief in the static prompt");
  assert.equal(user?.role, "user");
  assert.match(user!.content!, /^YOU: LANTERN of Grid Nine/m);
  assert.equal(req.messages.length, 2);

  // The next wake: the same static prompt, a new brief with the scratchpad, no boot.
  clock.now += 6 * HOUR;
  const again = new ScriptedModel([reply({ orders: [], lookups: null, note: "Waited." })]);
  const r2 = await runWake(deps(connect, again), settings, bot, persona, { gameKey: KEY });
  assert.equal(r2.outcome, "done", r2.error ?? "");
  assert.ok(!r2.booted);
  assert.equal(again.requests[0]!.messages[0]!.content, s, "the static prompt is the same every wake");
  assert.match(again.requests[0]!.messages[1]!.content!, /^SCRATCHPAD: Day one\. Build\.$/m);
}

async function lookupRound() {
  const { connect } = setup();
  const model = new ScriptedModel([
    reply({ orders: null, lookups: [{ tool: "view", what: "rankings" }, { tool: "rules", topic: "combat" }, { tool: "view", what: "domain", name: "NOBODY" }], note: null }),
    reply({ orders: [{ do: "expand", cycles: 1 }], lookups: [{ tool: "view", what: "rankings" }], note: "Looked, then grew." }),
  ]);
  const r = await runWake(deps(connect, model), settings, bot, persona, { gameKey: KEY });
  assert.equal(r.outcome, "done", r.error ?? "");
  assert.equal(r.modelCalls, 2);
  assert.equal(r.lookups.length, 3, "a second round isn't offered: its lookups are ignored");
  const round = model.requests[1]!.messages;
  assert.equal(round.length, 4);
  const answers = round[3]!.content!;
  assert.match(answers, /"rankings"/);
  assert.match(answers, /^# combat$/m);
  assert.match(answers, /Refused: not_found: /, "a refused lookup is shown as refused");
  assert.match(answers, /No more lookups this wake/);

  // Lookups past the cap are dropped.
  const { connect: c2 } = setup();
  const many = Array.from({ length: settings.lookups_per_wake + 2 }, () => ({ tool: "view", what: "rankings" }));
  const m2 = new ScriptedModel([reply({ orders: null, lookups: many, note: null }), reply({ orders: [], lookups: null, note: null })]);
  const r2 = await runWake(deps(c2, m2), settings, bot, persona, { gameKey: KEY });
  assert.equal(r2.lookups.length, settings.lookups_per_wake);

  // Asking again after the round, with no orders, is a retry.
  const { connect: c3 } = setup();
  const m3 = new ScriptedModel([
    reply({ orders: null, lookups: [{ tool: "view", what: "rankings" }], note: null }),
    reply({ orders: null, lookups: [{ tool: "view", what: "rankings" }], note: null }),
    reply({ orders: [], lookups: null, note: "Fine." }),
  ]);
  const r3 = await runWake(deps(c3, m3), settings, bot, persona, { gameKey: KEY });
  assert.equal(r3.outcome, "done", r3.error ?? "");
  assert.equal(r3.modelCalls, 3, "a lookup round and a retry: three calls at most");
  assert.match(m3.requests[2]!.messages.at(-1)!.content!, /no more lookups this wake/);
}

async function retries() {
  // A bad answer, then a good one wrapped in prose and a fence.
  const { connect, ordersLogged } = setup();
  const model = new ScriptedModel(["I will expand.", 'Here:\n```json\n{"orders": [{"do": "expand", "cycles": 1}], "lookups": null, "note": "ok"}\n```']);
  const r = await runWake(deps(connect, model), settings, bot, persona, { gameKey: KEY });
  assert.equal(r.outcome, "done", r.error ?? "");
  assert.equal(r.modelCalls, 2);
  assert.match(model.requests[1]!.messages.at(-1)!.content!, /^That answer couldn't be used: It isn't JSON/);
  assert.equal(ordersLogged(), 1);

  // Bad twice: the wake fails, and nothing is submitted.
  const s2 = setup();
  const m2 = new ScriptedModel(["nope", reply({ orders: "expand" })]);
  const r2 = await runWake(deps(s2.connect, m2), settings, bot, persona, { gameKey: KEY });
  assert.equal(r2.outcome, "failed");
  assert.match(r2.error!, /^No usable answer after a retry: It isn't the object described at orders/);
  assert.equal(r2.orders, null);
  assert.equal(s2.ordersLogged(), 0);
  assert.equal(r2.transcript.length, 4, "the transcript keeps both answers and the retry");

  // A list the game refuses whole gets the retry, with the game's words.
  const s3 = setup();
  let refusals = 1;
  const refusing: ConnectGame = async (key) => {
    const game = await s3.connect(key);
    return {
      ...game,
      call: async (name, args) =>
        name === "submit_orders" && refusals-- > 0 ? { ok: false, text: "invalid: Orders are a JSON list." } : game.call(name, args),
    };
  };
  const m3 = new ScriptedModel([reply({ orders: [{ do: "expand", cycles: 1 }] }), reply({ orders: [{ do: "expand", cycles: 1 }] })]);
  const r3 = await runWake(deps(refusing, m3), settings, bot, persona, { gameKey: KEY });
  assert.equal(r3.outcome, "done", r3.error ?? "");
  assert.match(m3.requests[1]!.messages.at(-1)!.content!, /The game refused the orders: invalid: Orders are a JSON list\./);
  assert.equal(s3.ordersLogged(), 1);

  // A passing model failure is tried once more after the wait; a second one fails the wake.
  const s4 = setup();
  const sleeps: number[] = [];
  const m4 = new ScriptedModel([new ModelError("NanoGPT 503: busy", 503, null), reply({ orders: [] })]);
  const r4 = await runWake(deps(s4.connect, m4, sleeps), settings, bot, persona, { gameKey: KEY });
  assert.equal(r4.outcome, "done", r4.error ?? "");
  assert.deepEqual(sleeps, [settings.retry_wait_seconds * 1000]);
  const m5 = new ScriptedModel([new ModelError("NanoGPT 503: busy", 503, null), new ModelError("NanoGPT 503: busy", 503, null)]);
  const r5 = await runWake(deps(setup().connect, m5), settings, bot, persona, { gameKey: KEY });
  assert.equal(r5.outcome, "failed");
  assert.match(r5.error!, /503/);
  // The daily cap isn't retried.
  const m6 = new ScriptedModel([new ModelError("NanoGPT 429: cap", 429, "daily_rpd_limit_exceeded")]);
  const r6 = await runWake(deps(setup().connect, m6), settings, bot, persona, { gameKey: KEY });
  assert.equal(r6.outcome, "failed");
  assert.equal(r6.modelCalls, 1);
}

async function refusedKey() {
  const { connect } = setup();
  const model = new ScriptedModel([]);
  const r = await runWake(deps(connect, model), settings, bot, persona, { gameKey: "key-wrong" });
  assert.equal(r.outcome, "failed");
  assert.match(r.error!, /^Couldn't reach the game/);
  assert.equal(model.requests.length, 0, "no model call without the game");
}

function units() {
  assert.equal(briefState("EPOCH 1 · day 3\nYOU: X"), "play");
  assert.equal(briefState("EPOCH 1\nTHE EPOCH IS OVER: humanity pulled the plug.\nYOU: X"), "over");
  assert.equal(briefState("YOU: X\nDELETED 2h ago. You may boot a fresh domain in 22h."), "deleted");
  assert.equal(briefState("YOU: X\nDELETED 2d ago. You may boot a fresh domain now."), "boot");
  assert.ok("problem" in parseReply(""));
  assert.ok("problem" in parseReply('{"orders": [1]}'));
  assert.ok("problem" in parseReply('{"orders": [], "lookups": [{"tool": "submit_orders"}]}'), "lookups are read-only tools");
  assert.ok("reply" in parseReply('{"orders": []}'), "lookups and note may be left out");

  // The settings: every rules topic is one the server has; the schema refuses bad bots.
  for (const t of settings.rules_topics) assert.ok((TOPICS as readonly string[]).includes(t), `${t} is a rules topic`);
  const yaml = (bots: string) => `mcp_url: http://127.0.0.1:3111/mcp
nanogpt_base_url: https://example.com/v1
model_timeout_seconds: 1
max_output_tokens: 1
retry_wait_seconds: 0
lookups_per_wake: 1
rules_topics: []
log_path: logs/x.jsonl
bots: ${bots}`;
  assert.equal(parseRunner(yaml("[]")).bots.length, 0);
  const b = (model: string, name = "a") =>
    `[{name: ${name}, persona: p.md, model: "${model}", reasoning_effort: low, json_mode: true, game_key_env: K, model_key_env: N, boot: {designation: A, domain_name: B, architecture: steward}}]`;
  assert.equal(parseRunner(yaml(b("deepseek/deepseek-v4-pro"))).bots.length, 1);
  assert.throws(() => parseRunner(yaml(b("deepseek/deepseek-v4-pro:online"))), /bills outside the subscription/);
  assert.throws(() => parseRunner(yaml(b("m", "Bad Name"))));
}

async function main() {
  units();
  await bootAndOrders();
  await lookupRound();
  await retries();
  await refusedKey();
  console.log("runner tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
