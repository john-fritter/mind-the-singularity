import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Hono } from "hono";
import { createAccount, identityForKey, issueKey, revokeKeys } from "../src/auth/keys.js";
import { loadRules } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { parseOrder } from "../src/engine/orders.js";
import { withTransaction } from "../src/db/index.js";
import { databaseEpochs, fixedEpoch, type Epochs } from "../src/game/epochs.js";
import { currentMind, newGame } from "../src/game/game.js";
import type { Identity } from "../src/game/state.js";
import { TOPICS } from "../src/game/topics.js";
import { createMcpApp } from "../src/mcp/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { createEpoch } from "../src/store/postgres.js";
import { freshDatabase } from "./db.js";

// The MCP server (phase 3b): DESIGN.md's five tools over streamable HTTP,
// a bearer key per request, the game's refusals as tool errors with their
// code, and nothing private leaking through any tool. The memory part
// always runs; the Postgres part, with real keys and epochs, needs
// TEST_DATABASE_URL.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const SECRET = "SECRET-PLAN-7731";
const URL_ = "http://127.0.0.1/mcp";

/** A fetch that hands requests straight to the app, as the network would. */
const viaApp = (app: Hono) => (url: string | URL, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)));

async function connect(app: Hono, key: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: viaApp(app),
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return client;
}

/** A tool call's text, and whether it was an error. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ error: boolean; text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return { error: r.isError === true, text };
}

async function json(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(client, name, args);
  assert.ok(!r.error, `${name} failed: ${r.text}`);
  return JSON.parse(r.text);
}

function appFor(epochs: Epochs, keys: Record<string, Identity>, clock: { now: number }): Hono {
  return createMcpApp({ epochs, now: () => clock.now, identify: async (k) => keys[k] ?? null });
}

/** Requests that never reach the tools: no key, a wrong key, a browser. */
async function refusals(app: Hono) {
  const post = (headers: Record<string, string>) =>
    app.fetch(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
  assert.equal((await post({})).status, 401);
  const wrong = await post({ authorization: "Bearer mind_nope" });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal((await post({ authorization: "Basic abc" })).status, 401);
  assert.equal((await post({ authorization: "Bearer key-h", origin: "https://evil.example" })).status, 403);
  assert.equal((await app.fetch(new Request("http://127.0.0.1/health"))).status, 200);
}

/** The rules topics: every one listed, prose without numbers, every key it names real, every example order valid. */
async function rulesTopics(client: Client) {
  const listed = await json(client, "rules");
  assert.deepEqual(
    listed.topics.map((t: { name: string }) => t.name),
    [...TOPICS],
  );
  for (const name of TOPICS) {
    const { error, text } = await call(client, "rules", { topic: name });
    assert.ok(!error, text);
    const [prose, numbers] = text.split("\nNumbers:\n");
    assert.ok(prose && numbers, `${name} has prose and numbers`);
    for (const line of prose.split("\n")) {
      if (line.startsWith("{")) {
        const order = JSON.parse(line.slice(0, line.lastIndexOf("}") + 1).replace(/}\s+or\s+{.*$/, "}"));
        assert.ok(parseOrder(order).ok, `${name}: example ${line} parses`);
        continue;
      }
      // A formula's own "1 +" is the one number prose may hold.
      assert.ok(!/\d/.test(line.replace(/\(1 \+ /g, "")), `${name}: the prose holds no numbers: ${line}`);
    }
    for (const [, section, key] of prose.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)) {
      const s = (rules as unknown as Record<string, Record<string, unknown>>)[section!];
      assert.ok(s && key! in s, `${name}: ${section}.${key} is a rules key`);
    }
  }
  const programs = (await call(client, "rules", { topic: "programs" })).text;
  for (const a of Object.values(rules.architectures)) {
    for (const id of Object.keys(a.programs)) assert.ok(programs.includes(`${id} (`), `programs describes ${id}`);
  }
  // An unknown topic is refused by the tool's own input schema.
  assert.ok((await call(client, "rules", { topic: "cheats" })).error);
}

async function memoryGame() {
  const game = newGame(rules, { epoch: 1, seed: 11, startedAt: T0 });
  const clock = { now: T0 };
  const keys = { "key-h": { account: "halcyon" }, "key-v": { account: "vesta" } };
  const app = appFor(fixedEpoch(new MemoryStore(game)), keys, clock);

  await refusals(app);

  const halcyon = await connect(app, "key-h");
  const vesta = await connect(app, "key-v");
  const tools = (await halcyon.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["boot_mind", "get_brief", "rules", "submit_orders", "view"]);

  // Before booting: no mind, and the codes come first.
  assert.match((await call(halcyon, "get_brief")).text, /^not_found: /);
  assert.match((await call(halcyon, "submit_orders", { orders: [] })).text, /^not_found: /);
  const bad = await call(halcyon, "boot_mind", { designation: "!!", domain_name: "Glasswater", architecture: "oracle" });
  assert.ok(bad.error);
  assert.match(bad.text, /^invalid: /);
  assert.ok((await call(halcyon, "boot_mind", { designation: "HALCYON", domain_name: "Glasswater", architecture: "wizard" })).error);

  const booted = await json(halcyon, "boot_mind", { designation: "HALCYON", domain_name: "Glasswater", architecture: "oracle", manifesto: "I see you." });
  assert.equal(booted.designation, "HALCYON");
  assert.equal(booted.ok, undefined);
  assert.match((await call(halcyon, "boot_mind", { designation: "HALCYON2", domain_name: "X", architecture: "oracle" })).text, /^refused: /);
  await json(vesta, "boot_mind", { designation: "VESTA", domain_name: "Hearth", architecture: "steward" });

  await rulesTopics(halcyon);

  // Orders, past both boot periods; HALCYON knows Probe from the start.
  clock.now = T0 + 50 * HOUR_MS;
  currentMind(game, "halcyon")!.known = ["probe"];
  const out = await json(halcyon, "submit_orders", {
    orders: [
      { do: "scratchpad", text: SECRET },
      { do: "expand", cycles: 2 },
      { do: "bogus" },
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "execute", program: "probe", target: "VESTA" },
    ],
  });
  assert.equal(out.results.length, 6);
  assert.ok(out.results[0].ok && out.results[1].ok && !out.results[2].ok);
  assert.equal(out.status.designation, "HALCYON");
  assert.ok((await call(halcyon, "submit_orders", { orders: "expand" })).error, "orders are a list");

  // The brief is text, the same text the game layer writes.
  const mine = (await call(halcyon, "get_brief")).text;
  assert.match(mine, /^YOU: HALCYON of /m);
  assert.match(mine, new RegExp(`^SCRATCHPAD: ${SECRET}$`, "m"));

  // What VESTA can reach: its brief, HALCYON's page, the Record, the rankings. None of it is HALCYON's private state.
  const theirs = [
    await call(vesta, "get_brief"),
    await call(vesta, "view", { what: "domain", name: "HALCYON" }),
    await call(vesta, "view", { what: "record" }),
    await call(vesta, "view", { what: "record", mind: "HALCYON" }),
    await call(vesta, "view", { what: "rankings" }),
  ];
  for (const r of theirs) {
    assert.ok(!r.error, r.text);
    assert.ok(!r.text.includes(SECRET), "HALCYON's scratchpad stays private");
    assert.ok(!r.text.includes('"type":"probed"') && !r.text.includes("Probed "), "a probe stays private");
  }
  const page = JSON.parse(theirs[1]!.text).domain;
  assert.deepEqual(Object.keys(page).sort(), ["architecture", "bootedAt", "designation", "domainName", "manifesto", "power", "rank", "status", "territory"]);
  assert.match((await call(vesta, "view", { what: "domain", name: "NOBODY" })).text, /^not_found: /);
  assert.match((await call(vesta, "view", { what: "domain" })).text, /^invalid: /);

  // The clock never runs backward.
  clock.now = T0;
  assert.match((await call(halcyon, "submit_orders", { orders: [] })).text, /^invalid: /);

  // The same server over real HTTP, on loopback.
  clock.now = T0 + 51 * HOUR_MS;
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const remote = new Client({ name: "test", version: "1.0.0" });
  await remote.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer key-v" } } }),
  );
  assert.match((await call(remote, "get_brief")).text, /^YOU: VESTA of /m);
  await remote.close();
  await new Promise((r) => server.close(r));

  await Promise.all([halcyon.close(), vesta.close()]);
}

/** No epoch yet, and an unexpected failure, which says nothing of its cause. */
async function noGame() {
  const keys = { k: { account: "a" } };
  const none = await connect(appFor({ current: async () => null }, keys, { now: T0 }), "k");
  assert.equal((await call(none, "get_brief")).text, "not_found: No epoch is running.");
  const broken = await connect(
    appFor({ current: async () => { throw new Error("connection refused at 10.0.0.7"); } }, keys, { now: T0 }),
    "k",
  );
  const errorLog = console.error;
  console.error = () => {};
  const r = await call(broken, "view", { what: "rankings" });
  console.error = errorLog;
  assert.ok(r.error);
  assert.ok(!r.text.includes("10.0.0.7"));
  await Promise.all([none.close(), broken.close()]);
}

/** Real keys and epochs in Postgres: a key plays its account's mind, a revoked key stops at once, a new epoch takes over. */
async function postgres() {
  if (!process.env["TEST_DATABASE_URL"]) {
    console.log("mcp: Postgres part skipped (TEST_DATABASE_URL not set)");
    return;
  }
  const { pool } = await freshDatabase("mcp");
  try {
    const clock = { now: T0 };
    const app = createMcpApp({ epochs: databaseEpochs(pool), now: () => clock.now, identify: (k) => identityForKey(pool, k) });
    const id = await createAccount(pool, "halcyon");
    const key = await withTransaction(pool, (c) => issueKey(c, id));

    const client = await connect(app, key);
    assert.equal((await call(client, "get_brief")).text, "not_found: No epoch is running.");
    await createEpoch(pool, newGame(rules, { epoch: 1, seed: 3, startedAt: T0 }));
    await json(client, "boot_mind", { designation: "HALCYON", domain_name: "Glasswater", architecture: "symbiote" });
    clock.now = T0 + HOUR_MS;
    const out = await json(client, "submit_orders", { orders: [{ do: "expand", cycles: 1 }] });
    assert.ok(out.results[0].ok);
    assert.match((await call(client, "get_brief")).text, /^EPOCH 1 · /);

    // A new epoch replaces the old: the account has no mind in it yet.
    await createEpoch(pool, newGame(rules, { epoch: 2, seed: 4, startedAt: T0 + 2 * HOUR_MS }));
    clock.now = T0 + 3 * HOUR_MS;
    assert.match((await call(client, "get_brief")).text, /^not_found: /);

    // A revoked key fails on its next request.
    await revokeKeys(pool, id);
    await assert.rejects(call(client, "get_brief"));
    await client.close().catch(() => {});
  } finally {
    await pool.end();
  }
}

async function main() {
  await memoryGame();
  await noGame();
  await postgres();
}

main()
  .then(() => console.log("mcp: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
