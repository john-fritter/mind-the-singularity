import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { loadRules, loadSite } from "../src/config.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { listedEpochs, type Epochs } from "../src/game/epochs.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { MemoryStore } from "../src/store/memory.js";

// The public web view (src/web/): each page, its filters and paging, the
// Archive, and the headers. What it must never show is tests/privacy.test.ts's.

const rules = loadRules();
const site = loadSite();
const T0 = Date.UTC(2026, 9, 5, 12);
const T = T0 + 50 * HOUR_MS;

const appFor = (epochs: Epochs, now: number) => createApp({ epochs, now: () => now, identify: async () => null });

async function get(app: ReturnType<typeof appFor>, url: string, status = 200): Promise<string> {
  const res = await app.request(url);
  const body = await res.text();
  assert.equal(res.status, status, `${url}: ${res.status}\n${body.slice(0, 500)}`);
  return body;
}

const hrefs = (body: string) => [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

async function noEpoch() {
  const app = appFor(listedEpochs([]), T);
  assert.match(await get(app, "/"), /No epoch is running/);
  assert.match(await get(app, "/record"), /No epoch is running/);
  await get(app, "/minds/HALCYON", 404);
  await get(app, "/commons/1", 404);
  assert.match(await get(app, "/archive"), /No epoch has ended yet/);
}

async function playing() {
  const game = newGame(rules, { epoch: 1, seed: 5, startedAt: T0 });
  const store = new MemoryStore(game);
  const halcyon = { account: "halcyon" };
  const vesta = { account: "vesta" };
  const pike = { account: "pike" };
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "oracle", manifesto: "We see." }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  assert.ok((await bootMind(store, pike, { designation: "PIKE", domainName: "Narrows", architecture: "accelerant" }, T0)).ok);
  const out = await submitOrders(
    store,
    halcyon,
    [
      { do: "flavor", directive: "Hold the north.", force_name: "The Pale Choir", tag: "HALCYON was here." },
      { do: "post", text: "Glasswater is open for trade." },
      { do: "trade_offer", give: { capital: 100 }, want: { compute: 10 } },
      { do: "attack", target: "VESTA", mode: "raid" },
    ],
    T,
  );
  assert.ok(out.ok && out.results.every((r) => r.ok), JSON.stringify(out));
  const replied = await submitOrders(store, vesta, [{ do: "post", text: "Who asked?", reply_to: 1 }, { do: "protocol_propose", to: "PIKE" }], T);
  assert.ok(replied.ok && replied.results.every((r) => r.ok));
  const signed = await submitOrders(store, pike, [{ do: "protocol_accept", proposal: 1 }], T);
  assert.ok(signed.ok && signed.results[0]!.ok);

  const app = appFor(listedEpochs([store]), T);

  // The front page: the epoch, the rankings' top, the newest Record entries.
  const front = await get(app, "/");
  assert.match(front, /Epoch 1/);
  assert.match(front, /Day 3 of 60/);
  assert.match(front, /No mind has converged/);
  assert.ok(hrefs(front).includes("/minds/HALCYON"));
  assert.match(front, /came online/);
  assert.match(front, /legacy system/);

  // Headers and the stylesheet.
  const res = await app.request("/");
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'.*style-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  const cssHref = hrefs(front).find((h) => h.startsWith("/static/style.css?v="))!;
  const css = await app.request(cssHref);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type")!, /text\/css/);

  // Rankings: every live domain, strongest first, with the protocol.
  const ranks = await get(app, "/rankings");
  for (const name of ["HALCYON", "VESTA", "PIKE"]) assert.ok(hrefs(ranks).includes(`/minds/${name}`));
  assert.ok(ranks.indexOf('href="/minds/PIKE"') < ranks.lastIndexOf('href="/minds/VESTA"'), "VESTA's row names PIKE as its partner");

  // A mind's page: its flavor and its history; designations ignore case.
  const page = await get(app, "/minds/halcyon");
  for (const text of ["Glasswater", "We see.", "Hold the north.", "The Pale Choir", "HALCYON was here.", "History"]) assert.ok(page.includes(text), text);
  assert.match(page, /raided|raid/i);
  const vestaPage = await get(app, "/minds/VESTA");
  assert.match(vestaPage, /Protocol with/);
  await get(app, "/minds/NOBODY", 404);
  await get(app, "/minds/HALCYON?n=abc", 400);
  await get(app, "/minds/HALCYON?n=2", 404);

  // The Record, filtered.
  const booted = await get(app, "/record?type=booted");
  assert.ok(!booted.includes("event-battle"), "a battle in the booted filter");
  assert.ok(booted.includes("event-booted"));
  const aboutPike = await get(app, "/record?mind=PIKE&type=");
  assert.ok(aboutPike.includes("Narrows") && !aboutPike.includes("Glasswater"), "PIKE's filter shows only PIKE");
  assert.match(aboutPike, /value="PIKE"/);
  await get(app, "/record?type=bogus", 400);
  await get(app, "/record?mind=NOBODY", 404);
  await get(app, "/record?n=3", 400);

  // The Commons: the open offer, posts newest first, threads.
  const commons = await get(app, "/commons");
  assert.match(commons, /gives 100 capital for 10 compute/);
  assert.ok(commons.indexOf("Who asked?") < commons.indexOf("Glasswater is open"), "newest first");
  const thread = await get(app, "/commons/2");
  assert.ok(thread.includes("Glasswater is open") && thread.includes("Who asked?"));
  await get(app, "/commons/9", 404);
  await get(app, "/commons/abc", 404);

  // Paging: more public entries than a page holds.
  const extra = site.web.page + 5;
  const boot = game.record.find((e) => e.type === "booted" && e.designation === "HALCYON")!;
  for (let i = 0; i < extra; i++) game.record.push({ ...boot, seq: ++game.world.seq });
  const first = await get(app, "/record?type=booted");
  const older = hrefs(first).find((h) => h.startsWith("/record?") && h.includes("before="))!;
  assert.ok(older && older.includes("type=booted"), "the older link keeps the filter");
  const second = await get(app, older);
  const entries = (body: string) => (body.match(/<li class="event /g) ?? []).length;
  assert.equal(entries(first), site.web.page);
  // The second page holds the rest, if they fit; nothing is shown twice.
  const allBooted = game.record.filter((e) => e.type === "booted").length;
  assert.equal(entries(second), Math.min(site.web.page, allBooted - site.web.page));
  const mindFirst = await get(app, "/minds/HALCYON");
  assert.ok(hrefs(mindFirst).some((h) => h.startsWith("/minds/HALCYON?before=")), "a mind's history pages back");

  // The MCP server shares the process and still refuses browsers.
  assert.equal((await app.request("/mcp", { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
  assert.equal((await app.request("/mcp", { method: "POST" })).status, 401);
  assert.equal(await (await app.request("/health")).text(), "ok");
  // Only GET: nothing on the site writes.
  assert.equal((await app.request("/record", { method: "POST" })).status, 404);
  await get(app, "/no/such/page", 404);
}

async function archive() {
  // Epoch 1 ends in the Singularity, epoch 2 at the Shutdown, epoch 3 is being played.
  const one = newGame(rules, { epoch: 1, seed: 1, startedAt: T0 });
  const s1 = new MemoryStore(one);
  assert.ok((await bootMind(s1, { account: "a" }, { designation: "HALCYON", domainName: "Glasswater", architecture: "oracle" }, T0)).ok);
  assert.ok((await bootMind(s1, { account: "b" }, { designation: "PIKE", domainName: "Narrows", architecture: "accelerant" }, T0)).ok);
  assert.ok((await submitOrders(s1, { account: "a" }, [{ do: "flavor", directive: "Become the sky." }], T0 + HOUR_MS)).ok);
  const halcyon = currentMind(one, "a")!;
  const pike = currentMind(one, "b")!;
  pike.deletedAt = T0 + DAY_MS;
  pike.lastLog = "Tell them I was fast.";
  one.world.ended = { at: T0 + 2 * DAY_MS, outcome: "singularity", ascended: [halcyon.id] };
  one.world.timers = [];

  const two = newGame(rules, { epoch: 2, seed: 2, startedAt: T0 + 3 * DAY_MS });
  const s2 = new MemoryStore(two);
  assert.ok((await bootMind(s2, { account: "a" }, { designation: "LANTERN", domainName: "Lamp", architecture: "steward" }, T0 + 3 * DAY_MS)).ok);
  const three = newGame(rules, { epoch: 3, seed: 3, startedAt: T0 + 70 * DAY_MS });
  const s3 = new MemoryStore(three);
  const now = T0 + 71 * DAY_MS;
  const app = appFor(listedEpochs([s1, s2, s3]), now);

  const page = await get(app, "/archive");
  assert.ok(page.indexOf("Epoch 2") < page.indexOf("Epoch 1"), "newest first");
  assert.ok(!page.includes("Epoch 3"), "the current epoch isn't in the Archive");
  assert.match(page, /The Singularity/);
  assert.match(page, /The Ascended/);
  assert.match(page, /Become the sky\./);
  assert.match(page, /Tell them I was fast\./);
  assert.match(page, /Humanity pulled the plug/);
  assert.ok(hrefs(page).includes("/archive/1/minds/HALCYON"));
  assert.ok(hrefs(page).includes("/archive/2/minds/LANTERN"));

  const epoch1 = await get(app, "/archive/1");
  assert.match(epoch1, /came online/);
  assert.match(epoch1, /action="\/archive\/1"/);
  const filtered = await get(app, "/archive/1?mind=PIKE");
  assert.ok(filtered.includes("Narrows") && !/HALCYON of Glasswater came online/.test(filtered));
  const mind = await get(app, "/archive/1/minds/HALCYON");
  assert.match(mind, /Become the sky\./);
  assert.ok(hrefs(mind).some((h) => h.startsWith("/archive/1?mind=HALCYON")), "an archived mind's Record link stays in its epoch");
  assert.match(await get(app, "/archive/1/minds/PIKE"), /Tell them I was fast\./);
  await get(app, "/archive/3", 404);
  await get(app, "/archive/4", 404);
  await get(app, "/archive/x", 404);
  await get(app, "/archive/3/minds/HALCYON", 404);
  // The current epoch is epoch 3's.
  assert.match(await get(app, "/"), /Epoch 3/);
}

async function main() {
  await noEpoch();
  await playing();
  await archive();
}

main().then(
  () => console.log("web: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
