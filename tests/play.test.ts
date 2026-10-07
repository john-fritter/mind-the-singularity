import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadRules } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { fixedEpoch } from "../src/game/epochs.js";
import { bootMind, currentMind, newGame } from "../src/game/game.js";
import { MemoryStore } from "../src/store/memory.js";
import { ordersFromForm } from "../src/web/forms.js";
import { logIn, memoryLogins, ORIGIN } from "./logins.js";

// The play pages (5c): logging in and out, the boot form, the dashboard and
// the order forms, each of which must reach submitOrders as the logged-in
// account and nothing else. What they must never show is privacy.test.ts's.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
let now = T0 + 50 * HOUR_MS;

type App = ReturnType<typeof createApp>;

function forms() {
  assert.deepEqual(ordersFromForm({ do: "expand", cycles: "3" }), { orders: [{ do: "expand", cycles: 3 }] });
  assert.deepEqual(ordersFromForm({ do: "build", building: "lab", count: " 2 " }), { orders: [{ do: "build", building: "lab", count: 2 }] });
  // Blank fields are left out, as an agent would leave them out.
  assert.deepEqual(ordersFromForm({ do: "attack", target: "VESTA", mode: "raid", program: "" }), { orders: [{ do: "attack", target: "VESTA", mode: "raid" }] });
  assert.deepEqual(ordersFromForm({ do: "execute", program: "probe", target: "" }), { orders: [{ do: "execute", program: "probe" }] });
  // The countermeasure's threshold is a percentage on the form; no program clears it.
  assert.deepEqual(ordersFromForm({ do: "set_countermeasure", program: "overclock", above: "80" }), { orders: [{ do: "set_countermeasure", program: "overclock", above: 0.8 }] });
  assert.deepEqual(ordersFromForm({ do: "set_countermeasure", program: "", above: "80" }), { orders: [{ do: "set_countermeasure", program: null }] });
  // A text may be blank: that clears it.
  assert.deepEqual(ordersFromForm({ do: "scratchpad", text: "" }), { orders: [{ do: "scratchpad", text: "" }] });
  // Fields a form doesn't have are dropped; an unknown form is refused.
  assert.deepEqual(ordersFromForm({ do: "expand", cycles: "1", extra: "x" }), { orders: [{ do: "expand", cycles: 1 }] });
  assert.ok("error" in ordersFromForm({ do: "seize_everything" }));
  // The JSON box: a list as it is, one order as a list of one, bad JSON refused.
  assert.deepEqual(ordersFromForm({ do: "json", orders: '[{"do":"expand"},{"do":"monetize","cycles":2}]' }), {
    orders: [{ do: "expand" }, { do: "monetize", cycles: 2 }],
  });
  assert.deepEqual(ordersFromForm({ do: "json", orders: '{"do":"expand"}' }), { orders: [{ do: "expand" }] });
  assert.ok("error" in ordersFromForm({ do: "json", orders: "[{" }));
}

const post = (app: App, url: string, cookie: string | null, fields: Record<string, string>, origin = ORIGIN) =>
  app.request(url, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });

async function page(app: App, url: string, cookie: string | null, status = 200): Promise<string> {
  const res = await app.request(url, cookie ? { headers: { cookie } } : {});
  const body = await res.text();
  assert.equal(res.status, status, `${url}: ${res.status}\n${body.slice(0, 400)}`);
  return body;
}

/** Posts an order form and reads the dashboard it sends you back to. */
async function order(app: App, cookie: string, fields: Record<string, string>): Promise<string> {
  const res = await post(app, "/play/orders", cookie, fields);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/play");
  return page(app, "/play", cookie);
}

async function playing() {
  const game = newGame(rules, { epoch: 1, seed: 7, startedAt: T0 });
  const store = new MemoryStore(game);
  assert.ok((await bootMind(store, { account: "vesta" }, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  const logins = memoryLogins({ kit: "kit-password-1", other: "other-password" });
  const app = createApp({ epochs: fixedEpoch(store), now: () => now, identify: async () => null, logins });

  // Logging in: a wrong password is refused, a right one sets a session cookie.
  const wrong = await post(app, "/login", null, { name: "kit", password: "nope" });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /don&#39;t match|don't match/);
  assert.equal(wrong.headers.get("set-cookie"), null);
  const res = await post(app, "/login", null, { name: "kit", password: "kit-password-1" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie")!, /mind_session=.+; Max-Age=3600; Path=\/; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(res.headers.get("set-cookie")!, /Secure/, "Secure only behind https");
  const cookie = await logIn(app, "kit", "kit-password-1");
  // Logged in, /login moves on to /play, and the masthead names the account.
  assert.equal((await app.request("/login", { headers: { cookie } })).status, 303);
  const front = await page(app, "/", cookie);
  assert.match(front, /href="\/play"/);
  assert.match(front, /href="\/settings">kit</);

  // A post from another site is refused, logged in or not.
  assert.equal((await post(app, "/play/boot", cookie, { designation: "KIT" }, "https://evil.example")).status, 403);

  // No mind yet: the boot form. Booting goes through bootMind as kit.
  const boot = await page(app, "/play", cookie);
  assert.match(boot, /Boot a mind/);
  assert.match(boot, /<option value="oracle">/);
  const bad = await post(app, "/play/boot", cookie, { designation: "", domainName: "Lamp", architecture: "oracle" });
  assert.equal(bad.status, 303);
  assert.match(await page(app, "/play", cookie), /class="error"/);
  const booted = await post(app, "/play/boot", cookie, { designation: "KIT", domainName: "Lamplight", architecture: "accelerant", manifesto: "Burn bright." });
  assert.equal(booted.status, 303);
  const kit = () => currentMind(game, "kit")!;
  assert.equal(kit().designation, "KIT");
  assert.equal(kit().manifesto, "Burn bright.");
  const dash = await page(app, "/play", cookie);
  assert.match(dash, /KIT is online/);
  assert.match(dash, /KIT <span class="muted">of Lamplight/);
  // The results show once.
  assert.doesNotMatch(await page(app, "/play", cookie), /KIT is online/);
  const fresh = await app.request("/play", { headers: { cookie } });
  assert.equal(fresh.headers.get("cache-control"), "no-store");

  // Each form's order reaches the log as kit's, as an agent's JSON would.
  const lastOrders = () => {
    const entry = game.log.at(-1)!;
    assert.equal(entry.account, "kit");
    return entry.kind === "orders" ? entry.orders : null;
  };
  now += HOUR_MS;
  assert.match(await order(app, cookie, { do: "expand", cycles: "2" }), /class="ok"/);
  assert.deepEqual(lastOrders(), [{ do: "expand", cycles: 2 }]);
  await order(app, cookie, { do: "build", building: "factory", count: "1" });
  assert.deepEqual(lastOrders(), [{ do: "build", building: "factory", count: 1 }]);
  await order(app, cookie, { do: "manufacture", unit: "drones", count: "5" });
  assert.deepEqual(lastOrders(), [{ do: "manufacture", unit: "drones", count: 5 }]);
  await order(app, cookie, { do: "set_research", program: "overclock" });
  assert.equal(kit().researchTarget, "overclock");
  await order(app, cookie, { do: "scratchpad", text: "kit's own notes" });
  assert.match(await page(app, "/play", cookie), /kit&#39;s own notes|kit's own notes/);
  // A refusal reads as the engine's reason.
  const refused = await order(app, cookie, { do: "attack", target: "VESTA", mode: "raid" });
  assert.match(refused, /refused: /);
  assert.deepEqual(lastOrders(), [{ do: "attack", target: "VESTA", mode: "raid" }]);
  // Several orders at once through the JSON box.
  await order(app, cookie, { do: "json", orders: '[{"do":"monetize"},{"do":"spin_up","cycles":1}]' });
  assert.deepEqual(lastOrders(), [{ do: "monetize" }, { do: "spin_up", cycles: 1 }]);
  const writes = game.log.length;
  assert.match(await order(app, cookie, { do: "json", orders: "not json" }), /isn&#39;t JSON|isn't JSON/);
  assert.equal(game.log.length, writes, "bad JSON writes nothing");

  // The dashboard: status, forms, the brief's sections; no other mind's private things.
  const full = await page(app, "/play", cookie);
  for (const text of ["Cycles", "Economy", "Military", "Orders as JSON", "In range", "The Commons", 'action="/play/orders"']) assert.ok(full.includes(text), `the dashboard lacks ${text}`);
  assert.doesNotMatch(full, /<script|\sstyle=/);

  // Another account never sees kit's scratchpad or results.
  const other = await logIn(app, "other", "other-password");
  const theirs = await page(app, "/play", other);
  assert.match(theirs, /Boot a mind/);
  assert.ok(!theirs.includes("kit's own notes") && !theirs.includes("kit&#39;s own notes"));

  // Settings: the current password must be right; a change ends the other sessions.
  const second = await logIn(app, "kit", "kit-password-1");
  const refusedChange = await post(app, "/settings/password", cookie, { current: "wrong", next: "a-new-password" });
  assert.equal(refusedChange.status, 400);
  assert.equal((await post(app, "/settings/password", cookie, { current: "kit-password-1", next: "a-new-password" })).status, 303);
  assert.match(await page(app, "/settings?done", cookie), /Your password is changed/);
  assert.equal((await app.request("/play", { headers: { cookie: second } })).status, 303, "the other session ended");

  // Logging out ends the session; the old cookie is nobody's.
  const out = await post(app, "/logout", cookie, {});
  assert.equal(out.status, 303);
  assert.match(out.headers.get("set-cookie")!, /mind_session=;/);
  const after = await app.request("/play", { headers: { cookie } });
  assert.equal(after.status, 303);
  assert.equal(after.headers.get("location"), "/login");
  assert.equal((await post(app, "/play/orders", cookie, { do: "expand", cycles: "1" })).status, 303);
  assert.equal(game.log.at(-1)!.account, "kit");
  assert.deepEqual(lastOrders(), [{ do: "monetize" }, { do: "spin_up", cycles: 1 }], "a logged-out post writes nothing");

  // The rules, by topic, for everyone.
  assert.match(await page(app, "/rules", null), /href="\/rules\/combat"/);
  assert.match(await page(app, "/rules/combat", null), /Numbers/);
  await page(app, "/rules/nothing", null, 404);
}

async function readOnly() {
  // Without logins the site is read-only: no login link, no play pages.
  const store = new MemoryStore(newGame(rules, { epoch: 1, seed: 7, startedAt: T0 }));
  const app = createApp({ epochs: fixedEpoch(store), now: () => now, identify: async () => null });
  assert.doesNotMatch(await page(app, "/", null), /\/login/);
  for (const url of ["/login", "/play", "/settings"]) await page(app, url, null, 404);
}

async function secure() {
  // Behind https the cookie is Secure.
  const store = new MemoryStore(newGame(rules, { epoch: 1, seed: 7, startedAt: T0 }));
  const app = createApp({ epochs: fixedEpoch(store), now: () => now, identify: async () => null, logins: memoryLogins({ kit: "kit-password-1" }), origin: "https://mind.example" });
  const res = await post(app, "/login", null, { name: "kit", password: "kit-password-1" }, "https://mind.example");
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie")!, /Secure/);
}

async function main() {
  forms();
  await playing();
  await readOnly();
  await secure();
}

main().then(
  () => console.log("play: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
