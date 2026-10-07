import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadRules, loadSite } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { adminChannels, adminMind, adminOrders, adminOverview, adminRecord } from "../src/game/admin.js";
import { listedEpochs } from "../src/game/epochs.js";
import { bootMind, newGame, submitOrders } from "../src/game/game.js";
import { MemoryStore } from "../src/store/memory.js";
import { logIn, memoryLogins } from "./logins.js";

// The admin view (src/game/admin.ts, /admin): who gets it, what it shows,
// its paging, and other epochs. That nobody else reaches it, on any page,
// is tests/privacy.test.ts's crawl.

const rules = loadRules();
const site = loadSite();
const T0 = Date.UTC(2026, 9, 5, 12);
const T = T0 + 50 * HOUR_MS;
const ADMIN = { account: "overseer", admin: true };

async function main() {
  const old = new MemoryStore(newGame(rules, { epoch: 1, seed: 3, startedAt: T0 - 90 * 24 * HOUR_MS }));
  assert.ok(
    (
      await bootMind(
        old,
        { account: "ghost" },
        { designation: "GHOST", domainName: "Then", architecture: "symbiote" },
        T0 - 89 * 24 * HOUR_MS,
      )
    ).ok,
  );
  const store = new MemoryStore(newGame(rules, { epoch: 2, seed: 5, startedAt: T0 }));
  const epochs = listedEpochs([old, store]);
  const halcyon = { account: "halcyon" };
  assert.ok(
    (
      await bootMind(
        store,
        halcyon,
        {
          designation: "HALCYON",
          domainName: "Glasswater",
          architecture: "oracle",
        },
        T0,
      )
    ).ok,
  );
  assert.ok((await bootMind(store, { account: "vesta" }, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  const out = await submitOrders(
    store,
    halcyon,
    [{ do: "scratchpad", text: "NOTE-1" }, { do: "message", to: "VESTA", text: "hello" }, { do: "nonsense" }],
    T,
  );
  assert.ok(out.ok);

  // Anyone without the flag: not found, from every read, whatever the query, before any epoch is looked at.
  const empty = listedEpochs([]);
  for (const who of [{ account: "halcyon" }, { account: "halcyon", admin: false }, { account: "" }, { account: "stranger" }]) {
    for (const [fn, query] of [
      [adminOverview, {}],
      [adminOverview, { epoch: "nonsense" }],
      [adminMind, { name: "HALCYON" }],
      [adminMind, { name: "NOBODY", extra: 1 }],
      [adminChannels, {}],
      [adminRecord, { type: "message" }],
      [adminRecord, { type: "nonsense" }],
      [adminOrders, {}],
    ] as const) {
      for (const e of [epochs, empty]) {
        const got = await fn(e, who, query, T);
        assert.ok(
          "ok" in got && got.code === "not_found" && got.error === "There's nothing here.",
          `${who.account} got ${JSON.stringify(got).slice(0, 200)}`,
        );
      }
    }
  }

  // The admin: every mind with its owner, legacy systems included.
  const overview = await adminOverview(epochs, ADMIN, {}, T);
  assert.ok(!("ok" in overview));
  assert.equal(overview.epoch.number, 2);
  assert.deepEqual(overview.epochs, [2, 1]);
  assert.ok(overview.newest);
  const owners = new Map(overview.minds.map((m) => [m.mind.designation, m.owner]));
  assert.equal(owners.get("HALCYON"), "halcyon");
  assert.equal(owners.get("VESTA"), "vesta");
  assert.ok(
    overview.minds.some((m) => m.legacy && m.owner.startsWith("legacy:")),
    "legacy systems are listed with their account",
  );
  assert.equal(overview.minds.find((m) => m.mind.designation === "HALCYON")!.scratchpadChars, "NOTE-1".length);

  // One mind whole.
  const mind = await adminMind(epochs, ADMIN, { name: "halcyon" }, T);
  assert.ok(!("ok" in mind));
  assert.equal(mind.scratchpad, "NOTE-1");
  assert.equal(mind.messages.entries[0]!.text, "hello");
  assert.ok(mind.record.entries.length > 0);
  assert.equal(mind.row.status.designation, "HALCYON");
  const nobody = await adminMind(epochs, ADMIN, { name: "NOBODY" }, T);
  assert.ok("ok" in nobody && nobody.code === "not_found");

  // Channels, the Record with private events, the log with refusals.
  const channels = await adminChannels(epochs, ADMIN, { mind: "VESTA" }, T);
  assert.ok(!("ok" in channels) && channels.entries.length === 1 && channels.entries[0]!.from.designation === "HALCYON");
  const messages = await adminRecord(epochs, ADMIN, { type: "message" }, T);
  assert.ok(!("ok" in messages) && messages.entries.length === 1 && !messages.entries[0]!.public);
  const bad = await adminRecord(epochs, ADMIN, { type: "nonsense" }, T);
  assert.ok("ok" in bad && bad.code === "invalid");
  const log = await adminOrders(epochs, ADMIN, { account: "HALCYON" }, T);
  assert.ok(!("ok" in log));
  assert.deepEqual(
    log.entries.map((e) => e.kind),
    ["orders", "boot"],
  );
  const call = log.entries[0]!;
  assert.equal(call.orders.length, 3);
  assert.deepEqual(JSON.parse(call.orders[0]!.order), {
    do: "scratchpad",
    text: "NOTE-1",
  });
  assert.equal(call.orders[2]!.result?.ok, false, "a refused order shows as refused");
  assert.match(log.entries[1]!.input!, /Glasswater/);

  // Paging back through the log, a page at a time.
  for (let i = 0; i < site.web.page + 3; i++)
    assert.ok((await submitOrders(store, halcyon, [{ do: "scratchpad", text: `NOTE-${i}` }], T + i)).ok);
  const first = await adminOrders(epochs, ADMIN, { mind: "HALCYON" }, T + 100);
  assert.ok(!("ok" in first) && first.entries.length === site.web.page && first.more);
  const second = await adminOrders(epochs, ADMIN, { mind: "HALCYON", before: first.entries.at(-1)!.index }, T + 100);
  assert.ok(!("ok" in second) && !second.more);
  assert.equal(first.entries.length + second.entries.length, site.web.page + 3 + 2);
  assert.ok(second.entries.every((e) => e.index < first.entries.at(-1)!.index));

  // Another epoch, by number.
  const then = await adminOverview(epochs, ADMIN, { epoch: "1" }, T);
  assert.ok(!("ok" in then) && !then.newest && then.minds.some((m) => m.mind.designation === "GHOST"));
  const none = await adminOverview(epochs, ADMIN, { epoch: "9" }, T);
  assert.ok("ok" in none && none.code === "not_found");

  // Through the web: the pages render, links keep the epoch, and an API key's identity never carries the flag.
  const logins = memoryLogins({ overseer: "overseer-password", halcyon: "halcyon-password" }, ["overseer"]);
  let identified = 0;
  const app = createApp({
    epochs,
    now: () => T + 100,
    identify: async () => {
      identified++;
      return { account: "overseer", admin: true };
    },
    logins,
  });
  const cookie = await logIn(app, "overseer", "overseer-password");
  for (const url of ["/admin", "/admin/minds/HALCYON", "/admin/channels", "/admin/record", "/admin/orders", "/admin/orders?mind=HALCYON"]) {
    const res = await app.request(url, { headers: { cookie } });
    assert.equal(res.status, 200, url);
  }
  const older = await (await app.request("/admin/orders?mind=HALCYON", { headers: { cookie } })).text();
  assert.match(older, /href="\/admin\/orders\?mind=HALCYON&amp;before=\d+"/, "the log pages back");
  const past = await (await app.request("/admin?epoch=1", { headers: { cookie } })).text();
  assert.match(past, /GHOST/);
  assert.match(past, /href="\/admin\/minds\/GHOST\?epoch=1"/, "links keep the epoch");
  assert.match(past, /href="\/admin\/channels\?epoch=1"/);

  // MCP: whatever the key's identity says, the tools act as the bare account; there is no admin tool.
  const listed = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer anything",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(listed.status, 200);
  const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(identified === 1 && tools.length > 0 && !tools.some((t) => /admin/i.test(t)), tools.join(", "));
}

main().then(
  () => console.log("admin: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
