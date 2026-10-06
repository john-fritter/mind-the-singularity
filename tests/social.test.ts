import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { briefText } from "../src/game/brief.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, view, type Brief, type ViewResult } from "../src/game/read.js";
import { replay } from "../src/game/replay.js";
import type { Identity } from "../src/game/state.js";
import { MemoryStore } from "../src/store/memory.js";

// Phase 4a: the Commons and channels. Posts and messages are free orders
// with a cap per epoch day; posts make one-level threads; a message waits
// for its recipient's next brief; `view` pages through the Commons, a
// thread and your own channels. What only two minds may see is in
// privacy.test.ts.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const halcyon = { account: "halcyon" };
const vesta = { account: "vesta" };
const pike = { account: "pike" };

async function setup() {
  const game = newGame(rules, { epoch: 1, seed: 7, startedAt: T0 });
  const store = new MemoryStore(game);
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "symbiote" }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  assert.ok((await bootMind(store, pike, { designation: "PIKE", domainName: "Narrows", architecture: "accelerant" }, T0)).ok);
  return { game, store };
}

async function orders(store: MemoryStore, who: Identity, list: unknown[], at: number) {
  const out = await submitOrders(store, who, list, at);
  assert.ok(out.ok, JSON.stringify(out));
  return out.results;
}

async function brief(store: MemoryStore, who: Identity, at: number): Promise<Brief> {
  const b = await getBrief(store, who, at);
  assert.ok(!("ok" in b), JSON.stringify(b));
  return b;
}

async function seen<W extends Extract<ViewResult, { ok: true }>["what"]>(
  store: MemoryStore,
  who: Identity,
  query: { what: W } & Record<string, unknown>,
  at: number,
): Promise<Extract<ViewResult, { what: W }>> {
  const r = await view(store, who, query, at);
  assert.ok(r.ok && r.what === query.what, JSON.stringify(r));
  return r as Extract<ViewResult, { what: W }>;
}

async function posts() {
  const { game, store } = await setup();
  const t = T0 + HOUR_MS;
  const r = await orders(
    store,
    halcyon,
    [
      { do: "post", text: "  Glasswater is open\nfor trade.  " },
      { do: "post", text: "Anyone near PIKE?", reply_to: 1 },
      { do: "post", text: "x", reply_to: 99 },
      { do: "post", text: "   " },
      { do: "post", text: "a".repeat(rules.social.post_chars + 1) },
      { do: "post", text: "bell\u0007" },
    ],
    t,
  );
  assert.deepEqual(r.map((x) => x.ok), [true, true, false, false, false, false]);
  assert.equal(r[0]!.cycles, 0, "posting is free");
  assert.match(r[1]!.message, /#2 in thread #1/);
  assert.match(r[2]!.message, /no post #99/);
  // A reply to a reply joins the first post's thread.
  assert.match((await orders(store, vesta, [{ do: "post", text: "I am.", reply_to: 2 }], t))[0]!.message, /#3 in thread #1/);
  assert.deepEqual(game.world.postRoots, [1, 1, 1]);

  const thread = await seen(store, pike, { what: "thread", post: 3 }, t);
  assert.deepEqual(
    thread.posts.map((p) => [p.post, p.author, p.replyTo, p.text]),
    [
      [1, "HALCYON", null, "Glasswater is open for trade."],
      [2, "HALCYON", 1, "Anyone near PIKE?"],
      [3, "VESTA", 1, "I am."],
    ],
  );
  assert.equal((await view(store, pike, { what: "thread", post: 4 }, t)).ok, false);
  const page = await seen(store, pike, { what: "commons", limit: 2 }, t);
  assert.deepEqual(page.posts.map((p) => p.post), [3, 2]);
  assert.ok(page.more);
  const back = await seen(store, pike, { what: "commons", before: 2 }, t);
  assert.deepEqual(back.posts.map((p) => p.post), [1]);
  assert.ok(!back.more);
  // Posts are the Commons, not the Record.
  const record = await seen(store, pike, { what: "record" }, t);
  assert.ok(record.entries.every((e) => e.type !== "post"));

  // The brief shows the newest posts, and what's left of the day's cap once some is used.
  const text = briefText(rules, await brief(store, halcyon, t));
  assert.match(text, new RegExp(`^COMMONS \\(newest 3\\) · you may post ${rules.social.commons_posts_per_day - 2} more today$`, "m"));
  assert.match(text, /^- #3 VESTA \(re #1, just now\): I am\.$/m);
  assert.doesNotMatch(text, /^CHANNELS/m, "no channel section with nothing in it");
}

async function caps() {
  const { game, store } = await setup();
  const cap = rules.social.commons_posts_per_day;
  const t = T0 + 20 * HOUR_MS;
  const r = await orders(store, halcyon, Array.from({ length: cap + 1 }, (_, i) => ({ do: "post", text: `post ${i}` })), t);
  assert.equal(r.filter((x) => x.ok).length, cap);
  assert.match(r.at(-1)!.message, /today's/);
  const m = await orders(store, halcyon, Array.from({ length: rules.social.messages_per_day + 1 }, () => ({ do: "message", to: "VESTA", text: "hi" })), t);
  assert.equal(m.filter((x) => x.ok).length, rules.social.messages_per_day);
  // Still the same epoch day an hour later; the next day the caps reset.
  assert.equal((await orders(store, halcyon, [{ do: "post", text: "again" }], t + HOUR_MS))[0]!.ok, false);
  const next = T0 + DAY_MS;
  assert.deepEqual((await orders(store, halcyon, [{ do: "post", text: "again" }, { do: "message", to: "vesta", text: "hi" }], next)).map((x) => x.ok), [true, true]);
  assert.deepEqual(currentMind(game, "halcyon")!.social, { day: 1, posts: 1, messages: 1, offers: 0 });
  const left = (await brief(store, halcyon, next)).commons.canPost;
  assert.equal(left, cap - 1);
}

async function channels() {
  const { game, store } = await setup();
  const t = T0 + HOUR_MS;
  const r = await orders(
    store,
    halcyon,
    [
      { do: "message", to: "vesta", text: "OUROBOROS needs three more. You in?" },
      { do: "message", to: "HALCYON", text: "me" },
      { do: "message", to: "NOBODY", text: "anyone" },
      { do: "message", to: rules.legacy.systems[0]!.designation, text: "hello" },
      { do: "message", to: "VESTA", text: "b".repeat(rules.social.message_chars + 1) },
    ],
    t,
  );
  assert.deepEqual(r.map((x) => x.ok), [true, false, false, false, false]);
  assert.equal(r[0]!.cycles, 0, "messaging is free");
  assert.match(r[3]!.message, /legacy system/);

  // VESTA reads it on its next wake, once.
  const later = t + 3 * HOUR_MS;
  const b = await brief(store, vesta, later);
  assert.deepEqual(b.channels.messages.map((m) => [m.from, m.to, m.text]), [["HALCYON", "VESTA", "OUROBOROS needs three more. You in?"]]);
  assert.ok(b.since.yours.every((e) => e.type !== "message"), "a message isn't news");
  const text = briefText(rules, b);
  assert.match(text, /^CHANNELS\n- HALCYON \(3h ago\): OUROBOROS needs three more\. You in\?$/m);
  // The sender's own channel section doesn't echo what it sent.
  assert.equal((await brief(store, halcyon, later)).channels.messages.length, 0);
  assert.match(briefText(rules, await brief(store, halcyon, later)), /^CHANNELS: nothing new · you may send \d+ more today$/m);

  await orders(store, vesta, [{ do: "message", to: "HALCYON", text: "In." }], later);
  assert.equal((await brief(store, vesta, later + HOUR_MS)).channels.messages.length, 0, "read once its orders are in");
  // view channel: both directions, newest first, only your own.
  const both = await seen(store, vesta, { what: "channel", name: "halcyon" }, later);
  assert.deepEqual(both.messages.map((m) => m.text), ["In.", "OUROBOROS needs three more. You in?"]);
  const all = await seen(store, halcyon, { what: "channel" }, later);
  assert.equal(all.messages.length, 2);
  const paged = await seen(store, halcyon, { what: "channel", limit: 1 }, later);
  assert.ok(paged.more && paged.messages[0]!.text === "In.");
  const earlier = await seen(store, halcyon, { what: "channel", before: paged.messages[0]!.seq }, later);
  assert.deepEqual(earlier.messages.map((m) => m.text), ["OUROBOROS needs three more. You in?"]);

  // The game rebuilds from its log, posts and messages included.
  await orders(store, pike, [{ do: "post", text: "Nothing personal." }], later);
  const rebuilt = replay(game);
  assert.deepEqual(rebuilt.world, game.world);
  assert.deepEqual(rebuilt.record, game.record);
}

async function main() {
  await posts();
  await caps();
  await channels();
}

main().then(
  () => console.log("social: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
