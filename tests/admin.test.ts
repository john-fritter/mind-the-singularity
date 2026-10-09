import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadRules, loadSite } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { adminChannels, adminMind, adminOrders, adminOverview, adminRecord } from "../src/game/admin.js";
import { listedEpochs } from "../src/game/epochs.js";
import { bootMind, newGame, submitOrders } from "../src/game/game.js";
import { MemoryStore } from "../src/store/memory.js";
import { csv } from "../src/web/download.js";
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
  assert.equal(overview.sort, "rank");
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
  assert.deepEqual(call.orders[0]!.order, {
    do: "scratchpad",
    text: "NOTE-1",
  });
  assert.equal(call.orders[0]!.type, "scratchpad");
  assert.equal(call.orders[2]!.result?.ok, false, "a refused order shows as refused");
  assert.match(JSON.stringify(log.entries[1]!.input), /Glasswater/);
  assert.equal(log.matched, 2);
  assert.equal(log.total, 3, "two boots and a call");

  // What the dropdowns offer comes from the epoch.
  assert.ok(log.choices.minds.some((m) => m.designation === "HALCYON" && !m.legacy && !m.deleted));
  assert.ok(log.choices.minds.some((m) => m.legacy), "legacy systems are offered");
  assert.ok(log.choices.accounts.includes("halcyon") && log.choices.accounts.includes("vesta"));
  assert.deepEqual(log.choices.orders, ["message", "nonsense", "scratchpad"]);
  assert.ok(log.choices.types.includes("message") && !log.choices.types.includes("battle"), "only the types the Record holds");
  assert.deepEqual(log.choices.days.map((d) => d.day), [3, 2, 1], "50 hours in: day 3");

  // An order type or a result narrows each call to its matching orders.
  const refused = await adminOrders(epochs, ADMIN, { result: "refused" }, T);
  assert.ok(!("ok" in refused) && refused.entries.length === 1);
  assert.deepEqual(
    refused.entries[0]!.orders.map((o) => [o.n, o.type]),
    [[3, "nonsense"]],
  );
  assert.equal(refused.entries[0]!.calls, 3);
  const messagesSent = await adminOrders(epochs, ADMIN, { order: "message" }, T);
  assert.ok(!("ok" in messagesSent) && messagesSent.entries.length === 1 && messagesSent.entries[0]!.orders[0]!.n === 2);
  const boots = await adminOrders(epochs, ADMIN, { order: "boot" }, T);
  assert.ok(!("ok" in boots) && boots.entries.length === 2 && boots.entries.every((e) => e.kind === "boot"));
  const dayOne = await adminOrders(epochs, ADMIN, { day: "1" }, T);
  assert.ok(!("ok" in dayOne) && dayOne.entries.every((e) => e.kind === "boot") && dayOne.matched === 2);
  const dayThree = await adminOrders(epochs, ADMIN, { day: "3" }, T);
  assert.ok(!("ok" in dayThree) && dayThree.matched === 1 && dayThree.entries[0]!.kind === "orders");

  // The Record by day and by who may see it; channels between a pair.
  const privately = await adminRecord(epochs, ADMIN, { seen: "private" }, T);
  assert.ok(!("ok" in privately) && privately.entries.length > 0 && privately.entries.every((e) => !e.public));
  const openly = await adminRecord(epochs, ADMIN, { seen: "public" }, T);
  assert.ok(!("ok" in openly) && openly.entries.every((e) => e.public) && openly.matched + privately.matched === openly.total);
  const pair = await adminChannels(epochs, ADMIN, { mind: "VESTA", with: "HALCYON" }, T);
  assert.ok(!("ok" in pair) && pair.entries.length === 1);
  const otherPair = await adminChannels(epochs, ADMIN, { mind: "VESTA", with: "VESTA" }, T);
  assert.ok(!("ok" in otherPair) && otherPair.entries.length === 0);
  const withOnly = await adminChannels(epochs, ADMIN, { with: "HALCYON" }, T);
  assert.ok(!("ok" in withOnly) && withOnly.entries.length === 1);
  const otherDay = await adminChannels(epochs, ADMIN, { day: "2" }, T);
  assert.ok(!("ok" in otherDay) && otherDay.entries.length === 0 && otherDay.total === 1);

  // The overview counts each mind's orders; sorts keep everyone.
  const after = await adminOverview(epochs, ADMIN, { sort: "refused" }, T);
  assert.ok(!("ok" in after));
  assert.equal(after.minds[0]!.mind.designation, "HALCYON");
  assert.deepEqual([after.minds[0]!.orders, after.minds[0]!.refused, after.minds[0]!.lastOrderAt], [3, 1, T]);
  const quiet = await adminOverview(epochs, ADMIN, { sort: "quiet" }, T);
  assert.ok(!("ok" in quiet) && quiet.minds.at(-1)!.mind.designation === "HALCYON" && quiet.minds.length === after.minds.length);
  assert.ok("ok" in (await adminOverview(epochs, ADMIN, { sort: "nonsense" }, T)));

  // Paging back through the log, a page at a time.
  const page = site.web.admin_page;
  for (let i = 0; i < page + 3; i++)
    assert.ok((await submitOrders(store, halcyon, [{ do: "scratchpad", text: `NOTE-${i}` }], T + i)).ok);
  const first = await adminOrders(epochs, ADMIN, { mind: "HALCYON" }, T + 100);
  assert.ok(!("ok" in first) && first.entries.length === page && first.more && first.matched === page + 5);
  const second = await adminOrders(epochs, ADMIN, { mind: "HALCYON", before: first.entries.at(-1)!.index }, T + 100);
  assert.ok(!("ok" in second) && !second.more);
  assert.equal(first.entries.length + second.entries.length, page + 3 + 2);
  assert.ok(second.entries.every((e) => e.index < first.entries.at(-1)!.index));
  // Whole, for a download: every match, oldest first, whatever `before` says.
  const whole = await adminOrders(epochs, ADMIN, { mind: "HALCYON", before: 3 }, T + 100, "whole");
  assert.ok(!("ok" in whole) && whole.entries.length === page + 5 && !whole.more);
  assert.ok(whole.entries.every((e, i) => i === 0 || e.index > whole.entries[i - 1]!.index));
  const wholeRecord = await adminRecord(epochs, ADMIN, {}, T + 100, "whole");
  assert.ok(!("ok" in wholeRecord) && wholeRecord.entries.length === wholeRecord.total && wholeRecord.entries.every((e) => e.raw?.seq === e.seq));

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

  // The filters are dropdowns of what the epoch holds, and the logs sit in a scroll box.
  const recordPage = await (await app.request("/admin/record?mind=vesta&day=3", { headers: { cookie } })).text();
  assert.match(recordPage, /<select name="mind">[\s\S]*<option value="VESTA" selected="">VESTA<\/option>/, "the mind dropdown keeps its pick");
  assert.match(recordPage, /<option value="3" selected="">3 \(7 Oct\)<\/option>/, "days are named by date");
  assert.match(recordPage, /class="logbox"/);
  assert.match(recordPage, /href="\/admin\/record\.csv\?mind=vesta&amp;day=3"/, "a download keeps the filters");
  const ordersPage = await (await app.request("/admin/orders", { headers: { cookie } })).text();
  assert.match(ordersPage, /<option value="halcyon">halcyon<\/option>/);
  assert.match(ordersPage, /<option value="nonsense">nonsense<\/option>/);
  assert.match(ordersPage, /boots and calls/);

  // Downloads: every match as a file to save, CSV or JSON.
  const download = async (url: string) => {
    const res = await app.request(url, { headers: { cookie } });
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="mind-[a-z0-9-]+\.(csv|json)"$/, url);
    return { type: res.headers.get("content-type") ?? "", body: await res.text() };
  };
  const ordersCsv = await download("/admin/orders.csv?mind=HALCYON");
  assert.match(ordersCsv.type, /^text\/csv/);
  const lines = ordersCsv.body.trimEnd().split("\r\n");
  assert.equal(lines[0], "index,time,day,account,mind,kind,n,order_type,order,ok,message,cycles");
  assert.equal(lines.length, 1 + 1 + 3 + page + 3, "a header, the boot, then one line per order");
  assert.match(lines[2]!, /^3,[^,]+,3,halcyon,HALCYON,orders,1,scratchpad,"\{""do"":""scratchpad"",""text"":""NOTE-1""\}",true,/);
  const ordersJson = JSON.parse((await download("/admin/orders.json?result=refused")).body) as { epoch: number; filters: unknown; entries: { orders: unknown[] }[] };
  assert.equal(ordersJson.epoch, 2);
  assert.deepEqual(ordersJson.filters, { result: "refused" });
  assert.equal(ordersJson.entries.length, 1);
  const recordJson = JSON.parse((await download("/admin/record.json")).body) as { entries: { seq: number; event: { seq: number } }[] };
  assert.ok(recordJson.entries.length > 0 && recordJson.entries.every((e, i) => e.event.seq === e.seq && (i === 0 || e.seq > recordJson.entries[i - 1]!.seq)));
  assert.match((await download("/admin/record.csv?type=message")).body, /^seq,time,day,type,public,minds,text\r\n\d+,[^,]+,3,message,false,HALCYON VESTA,/);
  assert.match((await download("/admin/channels.csv")).body, /,HALCYON,VESTA,hello\r\n$/);
  assert.match((await download("/admin/minds.csv")).body, /^rank,mind,owner,/);
  const epochFile = JSON.parse((await download("/admin/epoch.json?epoch=1")).body) as { epoch: number; start: { seed: number }; log: unknown[] };
  assert.deepEqual([epochFile.epoch, epochFile.start.seed, epochFile.log.length], [1, 3, 1]);
  assert.equal((await app.request("/admin/record.csv?type=nonsense", { headers: { cookie } })).status, 400);
  assert.equal((await app.request("/admin/orders.json?epoch=9", { headers: { cookie } })).status, 404);

  // CSV quoting, and texts a spreadsheet would run as formulas.
  assert.equal(csv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", null], ["=SUM(A1)", -5], ["@cmd", "+1"]]), 'a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n\'=SUM(A1),-5\r\n\'@cmd,\'+1\r\n');

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
