import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { deleteMind } from "../src/engine/deletion.js";
import { computeStorage } from "../src/engine/economy.js";
import { briefText } from "../src/game/brief.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, view, type Brief, type ViewResult } from "../src/game/read.js";
import { replay } from "../src/game/replay.js";
import type { Identity } from "../src/game/state.js";
import { MemoryStore } from "../src/store/memory.js";

// Phase 4b: trades held in escrow. An offer takes its goods out of the
// domain at once; acceptance swaps them at once; cancelling or expiry
// returns them; a won attack or a landed program that takes goods first
// withdraws the target's offers; deletion takes them with the domain. What
// only two minds may see is in privacy.test.ts.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const halcyon = { account: "halcyon" };
const vesta = { account: "vesta" };
const pike = { account: "pike" };
const EXPIRY = rules.social.trade_expiry_hours * HOUR_MS;

async function setup() {
  const game = newGame(rules, { epoch: 1, seed: 7, startedAt: T0 });
  const store = new MemoryStore(game);
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "symbiote" }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  assert.ok((await bootMind(store, pike, { designation: "PIKE", domainName: "Narrows", architecture: "accelerant" }, T0)).ok);
  const mind = (who: Identity) => currentMind(game, who.account)!;
  return { game, store, mind };
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

/** Offers: escrow at once, and every refusal costs nothing. */
async function offers() {
  const { game, store, mind } = await setup();
  const t = T0 + HOUR_MS;
  const before = { capital: mind(halcyon).capital, compute: mind(halcyon).compute };
  const r = await orders(
    store,
    halcyon,
    [
      { do: "trade_offer", give: { capital: 1000 }, want: { compute: 300 } },
      { do: "trade_offer", give: { compute: 200 }, want: { capital: 700 }, to: "vesta" },
      { do: "trade_offer", give: { capital: 10 }, want: { capital: 20 } },
      { do: "trade_offer", give: { capital: 10, compute: 1 }, want: { compute: 20 } },
      { do: "trade_offer", give: {}, want: { compute: 20 } },
      { do: "trade_offer", give: { capital: 0 }, want: { compute: 20 } },
      { do: "trade_offer", give: { capital: 10 }, want: { compute: 20 }, to: "HALCYON" },
      { do: "trade_offer", give: { capital: 10 }, want: { compute: 20 }, to: "BASTION" },
      { do: "trade_offer", give: { capital: 10 }, want: { compute: 20 }, to: "NOBODY" },
      { do: "trade_offer", give: { capital: 10 ** 9 }, want: { compute: 20 } },
    ],
    t,
  );
  assert.deepEqual(r.map((x) => x.ok), [true, true, false, false, false, false, false, false, false, false]);
  assert.equal(r[0]!.cycles, 0, "offering is free");
  assert.match(r[0]!.message, /^Offer #1: 1,000 capital for 300 compute, in escrow for 48h\.$/);
  assert.match(r[1]!.message, /^Offer #2 to VESTA: 200 compute for 700 capital/);
  assert.match(r[2]!.message, /capital for compute or compute for capital/);
  assert.match(r[3]!.message, /name capital or compute, one of them/);
  assert.match(r[4]!.message, /name capital or compute/);
  assert.match(r[5]!.message, /Invalid order/);
  assert.match(r[6]!.message, /yourself/);
  assert.match(r[7]!.message, /legacy system/);
  assert.match(r[8]!.message, /No mind called NOBODY/);
  assert.match(r[9]!.message, /^You have [\d,]+ capital; the offer gives 1,000,000,000 capital\.$/);
  assert.equal(mind(halcyon).capital, before.capital - 1000, "the capital is in escrow");
  assert.equal(mind(halcyon).compute, before.compute - 200, "so is the compute");
  assert.deepEqual(
    game.world.offers.map((o) => [o.id, o.to, o.give, o.want, o.expiresAt]),
    [
      [1, null, { goods: "capital", amount: 1000 }, { goods: "compute", amount: 300 }, t + EXPIRY],
      [2, mind(vesta).id, { goods: "compute", amount: 200 }, { goods: "capital", amount: 700 }, t + EXPIRY],
    ],
  );
  assert.equal(game.world.timers.filter((x) => x.kind === "offer_expires").length, 2);
  assert.equal(mind(halcyon).social.offers, 2, "only offers made count toward the day's cap");

  // At most open_offers_max open at once.
  const more = await orders(store, halcyon, Array.from({ length: rules.social.open_offers_max }, () => ({ do: "trade_offer", give: { capital: 1 }, want: { compute: 1 } })), t);
  assert.equal(more.filter((x) => x.ok).length, rules.social.open_offers_max - 2);
  assert.match(more.at(-1)!.message, /offers open, the most you may; cancel one first/);

  // At most trade_offers_per_day made a day, cancelled or not; the next day it resets.
  const churn: unknown[] = [];
  for (let i = 0; i < rules.social.trade_offers_per_day; i++) {
    // Offers count from 1, so the oldest open one is always i + 1.
    churn.push({ do: "trade_cancel", offer: i + 1 }, { do: "trade_offer", give: { capital: 1 }, want: { compute: 1 } });
  }
  const c = await orders(store, halcyon, churn, t);
  const made = c.filter((x) => x.do === "trade_offer");
  assert.equal(made.filter((x) => x.ok).length, rules.social.trade_offers_per_day - rules.social.open_offers_max);
  assert.match(made.at(-1)!.message, /today's 10 offers/);
  const next = await orders(store, halcyon, [{ do: "trade_offer", give: { capital: 1 }, want: { compute: 1 } }], T0 + DAY_MS);
  assert.ok(next[0]!.ok, next[0]!.message);
  assert.equal((await brief(store, halcyon, T0 + DAY_MS)).offers.canOffer, rules.social.trade_offers_per_day - 1);
}

/** Acceptance swaps the goods at once, and the trade is in the Record. */
async function accepting() {
  const { game, store, mind } = await setup();
  const t = T0 + HOUR_MS;
  await orders(
    store,
    halcyon,
    [
      { do: "trade_offer", give: { capital: 1000 }, want: { compute: 300 } },
      { do: "trade_offer", give: { compute: 200 }, want: { capital: 700 }, to: "VESTA" },
    ],
    t,
  );
  const h = { capital: mind(halcyon).capital, compute: mind(halcyon).compute };
  const v = { capital: mind(vesta).capital, compute: mind(vesta).compute };
  const p = { capital: mind(pike).capital, compute: mind(pike).compute };

  // PIKE can't see #2: it's VESTA's, and as good as missing to anyone else.
  const r = await orders(
    store,
    pike,
    [
      { do: "trade_accept", offer: 2 },
      { do: "trade_accept", offer: 99 },
      { do: "trade_cancel", offer: 1 },
      { do: "trade_accept", offer: 1 },
      { do: "trade_accept", offer: 1 },
    ],
    t,
  );
  assert.deepEqual(r.map((x) => x.ok), [false, false, false, true, false]);
  assert.equal(r[0]!.message, r[1]!.message.replace("99", "2"), "another mind's offer reads as missing");
  assert.match(r[2]!.message, /isn't yours to cancel/);
  assert.equal(r[3]!.message, "Trade #1: you paid 300 compute to HALCYON for 1,000 capital.");
  assert.equal(r[3]!.cycles, 0);
  assert.match(r[4]!.message, /no open offer #1/, "an offer is taken once");
  assert.deepEqual([mind(pike).capital, mind(pike).compute], [p.capital + 1000, p.compute - 300]);
  assert.deepEqual([mind(halcyon).capital, mind(halcyon).compute], [h.capital, h.compute + 300]);

  // The maker can't take its own; the taker needs what's wanted.
  assert.match((await orders(store, halcyon, [{ do: "trade_accept", offer: 2 }], t))[0]!.message, /your own; trade_cancel/);
  mind(vesta).capital = 699;
  assert.match((await orders(store, vesta, [{ do: "trade_accept", offer: 2 }], t))[0]!.message, /^Offer #2 wants 700 capital; you have 699\.$/);
  mind(vesta).capital = v.capital;
  // Nor more compute than it can store.
  const storage = computeStorage(rules, mind(vesta).buildings.datacenter);
  mind(vesta).compute = storage - 199;
  assert.match((await orders(store, vesta, [{ do: "trade_accept", offer: 2 }], t))[0]!.message, /you can store 199 more/);
  mind(vesta).compute = v.compute;
  assert.ok((await orders(store, vesta, [{ do: "trade_accept", offer: 2 }], t))[0]!.ok);
  assert.deepEqual([mind(vesta).capital, mind(vesta).compute], [v.capital - 700, v.compute + 200]);
  assert.equal(mind(halcyon).capital, h.capital + 700);
  assert.equal(game.world.offers.length, 0);
  assert.equal(game.world.timers.filter((x) => x.kind === "offer_expires").length, 0, "a taken offer's timer goes with it");

  // Done trades are public, and the maker hears of them on its next wake.
  const record = await seen(store, { account: "stranger" }, { what: "record", type: "trade" }, t);
  assert.deepEqual(
    record.entries.map((e) => e.text),
    ["Trade #2: HALCYON gave 200 compute to VESTA for 700 capital.", "Trade #1: HALCYON gave 1,000 capital to PIKE for 300 compute."],
  );
  const hb = await brief(store, halcyon, t + HOUR_MS);
  assert.ok(hb.since.yours.some((e) => e.text.startsWith("Trade #2: HALCYON gave 200 compute to VESTA")));

  // Compute the maker can't store is lost, and only the maker hears of it.
  await orders(store, halcyon, [{ do: "trade_offer", give: { capital: 100 }, want: { compute: 500 } }], t);
  mind(halcyon).compute = computeStorage(rules, mind(halcyon).buildings.datacenter) - 100;
  assert.ok((await orders(store, pike, [{ do: "trade_accept", offer: 3 }], t))[0]!.ok);
  assert.equal(mind(halcyon).compute, computeStorage(rules, mind(halcyon).buildings.datacenter));
  const full = game.record.find((e) => e.type === "storage_full")!;
  assert.ok(full && !full.public && full.type === "storage_full" && full.compute === 400);
  assert.match(briefText(rules, await brief(store, halcyon, t + HOUR_MS)), /^- Trade #3: 400 compute lost; your storage was full\.$/m);
}

/** Cancelling and expiry return exactly what went into escrow. */
async function returning() {
  const { game, store, mind } = await setup();
  const t = T0 + HOUR_MS;
  const h = { capital: mind(halcyon).capital, compute: mind(halcyon).compute };
  await orders(
    store,
    halcyon,
    [
      { do: "trade_offer", give: { capital: 1000 }, want: { compute: 300 } },
      { do: "trade_offer", give: { compute: 200 }, want: { capital: 700 }, to: "VESTA" },
    ],
    t,
  );
  const r = await orders(store, halcyon, [{ do: "trade_cancel", offer: 1 }, { do: "trade_cancel", offer: 1 }], t + HOUR_MS);
  assert.equal(r[0]!.message, "Offer #1 cancelled: 1,000 capital back from escrow.");
  assert.match(r[1]!.message, /no open offer #1/);
  assert.equal(mind(halcyon).capital, h.capital);

  // #2 expires on its timer: the compute comes back, and the maker's brief says so.
  const due = t + EXPIRY;
  const early = await brief(store, halcyon, due - 1);
  assert.deepEqual(early.offers.yours.map((o) => o.offer), [2]);
  const expired = await brief(store, halcyon, due);
  assert.deepEqual(expired.offers.yours, []);
  assert.ok(expired.since.yours.some((e) => e.text === "Offer #2 expired: 200 compute back from escrow."));
  // A read settles a copy; the next write settles to the same result, once.
  await orders(store, halcyon, [], due);
  assert.equal(mind(halcyon).compute, h.compute);
  assert.equal(game.record.filter((e) => e.type === "offer_expired").length, 1);
  await orders(store, halcyon, [], due + HOUR_MS);
  assert.equal(game.record.filter((e) => e.type === "offer_expired").length, 1, "settling again changes nothing");
  assert.ok(game.record.filter((e) => e.type === "offer_expired").every((e) => !e.public && e.domains.join() === String(mind(halcyon).id)));
  assert.deepEqual(game.world.offers, []);

  // Escrowed compute that no longer fits storage when it comes back is lost.
  await orders(store, halcyon, [{ do: "trade_offer", give: { compute: 200 }, want: { capital: 1 } }], due + HOUR_MS);
  mind(halcyon).compute = computeStorage(rules, mind(halcyon).buildings.datacenter) - 50;
  assert.match((await orders(store, halcyon, [{ do: "trade_cancel", offer: 3 }], due + HOUR_MS))[0]!.message, /\(150 compute lost: storage full\)/);
}

/** Escrow is no vault: a won raid withdraws the target's offers before it takes its share. */
async function hits() {
  const { game, store, mind } = await setup();
  const t = T0 + 3 * DAY_MS;
  await orders(store, halcyon, [{ do: "trade_offer", give: { capital: 4000 }, want: { compute: 99_999 } }], t - HOUR_MS);
  const capital = mind(halcyon).capital + 4000;
  // HALCYON has nothing to defend with; PIKE wins.
  mind(halcyon).units = {};
  const raid = await orders(store, pike, [{ do: "attack", target: "HALCYON", mode: "raid" }], t);
  assert.ok(raid[0]!.ok, raid[0]!.message);
  const battle = game.record.findLast((e) => e.type === "battle_report")!;
  assert.ok(battle.type === "battle_report" && battle.attackerWon, "PIKE won");
  assert.equal(battle.capital, Math.floor(capital * rules.combat.raid_capital_share), "the raid took its share of what was in escrow too");
  assert.equal(mind(halcyon).capital, capital - battle.capital);
  assert.deepEqual(game.world.offers, []);
  const withdrawn = game.record.find((e) => e.type === "offers_withdrawn")!;
  assert.ok(withdrawn.type === "offers_withdrawn" && !withdrawn.public && withdrawn.capital === 4000);
  assert.ok(withdrawn.seq < battle.seq, "withdrawn before the raid took its share");
  const text = briefText(rules, await brief(store, halcyon, t));
  assert.match(text, /^- You were hit, so your offer #1 was withdrawn: 4,000 capital back from escrow, within reach\.$/m);

  // So does a hostile program that takes capital, once it lands: HALCYON's Blight on VESTA.
  await orders(store, vesta, [{ do: "trade_offer", give: { capital: 3000 }, want: { compute: 1 } }], t);
  mind(halcyon).known = ["blight"];
  mind(halcyon).compute = 5000;
  mind(vesta).buildings.firewall = 0;
  const vCapital = mind(vesta).capital + 3000;
  const blight = await orders(store, halcyon, Array.from({ length: 3 }, () => ({ do: "execute", program: "blight", target: "VESTA" })), t);
  assert.ok(blight.some((x) => x.ok), "one of three Blights lands");
  const hostile = game.record.find((e) => e.type === "hostile" && !e.blocked)!;
  const destroyed = game.record.reduce((sum, e) => sum + (e.type === "hostile" ? (e.effect.capital ?? 0) : 0), 0);
  assert.ok(destroyed > 0);
  assert.equal(mind(vesta).capital, vCapital - destroyed, "the escrow came back before Blight took its share");
  assert.deepEqual(game.world.offers, []);
  assert.ok(game.record.some((e) => e.type === "offers_withdrawn" && e.domain === mind(vesta).id && e.seq < hostile.seq));
}

/** A deleted mind's offers go with its domain. */
async function deletion() {
  const { game, store, mind } = await setup();
  await orders(store, halcyon, [{ do: "trade_offer", give: { capital: 1000 }, want: { compute: 300 } }], T0 + HOUR_MS);
  deleteMind(game.world, mind(halcyon), T0 + HOUR_MS, [], null);
  assert.deepEqual(game.world.offers, []);
  assert.ok(!game.world.timers.some((x) => x.kind === "offer_expires"));
  assert.match((await orders(store, pike, [{ do: "trade_accept", offer: 1 }], T0 + 2 * HOUR_MS))[0]!.message, /no open offer #1/);
}

/** The brief, `view offers` and `view commons` show what's open; a replay rebuilds it all. */
async function showing() {
  const { game, store } = await setup();
  const t = T0 + HOUR_MS;
  await orders(
    store,
    halcyon,
    [
      { do: "trade_offer", give: { capital: 1000 }, want: { compute: 300 } },
      { do: "trade_offer", give: { compute: 200 }, want: { capital: 700 }, to: "VESTA" },
    ],
    t,
  );
  await orders(store, pike, [{ do: "trade_offer", give: { compute: 50 }, want: { capital: 150 } }], t);

  const text = briefText(rules, await brief(store, vesta, t + HOUR_MS));
  assert.match(
    text,
    /^OPEN OFFERS\n- #2 HALCYON gives 200 compute for 700 capital · to you · 1d 23h left\n- #1 HALCYON gives 1,000 capital for 300 compute · 1d 23h left\n- #3 PIKE gives 50 compute for 150 capital · 1d 23h left$/m,
  );
  const mine = briefText(rules, await brief(store, halcyon, t + HOUR_MS));
  assert.match(mine, /^OPEN OFFERS · you may offer 8 more today\n- #3 PIKE gives 50 compute for 150 capital · 1d 23h left\n- yours: #1 \(1d 23h left\), #2 \(1d 23h left\)$/m);
  assert.doesNotMatch(briefText(rules, await brief(store, pike, t + HOUR_MS)), /#2 /, "PIKE doesn't see VESTA's offer");

  assert.deepEqual((await seen(store, vesta, { what: "offers" }, t)).offers.map((o) => o.offer), [1, 2, 3]);
  assert.deepEqual((await seen(store, pike, { what: "offers" }, t)).offers.map((o) => o.offer), [1, 3]);
  assert.deepEqual((await seen(store, { account: "stranger" }, { what: "offers" }, t)).offers.map((o) => o.offer), [1, 3]);
  const commons = await seen(store, pike, { what: "commons" }, t);
  assert.deepEqual(commons.offers.map((o) => [o.offer, o.from, o.to]), [[1, "HALCYON", null], [3, "PIKE", null]]);

  await orders(store, vesta, [{ do: "trade_accept", offer: 2 }, { do: "trade_accept", offer: 3 }], t + 2 * HOUR_MS);
  await orders(store, halcyon, [{ do: "trade_cancel", offer: 1 }, { do: "trade_offer", give: { capital: 5 }, want: { compute: 5 } }], t + 3 * HOUR_MS);
  await getBrief(store, halcyon, t + 3 * DAY_MS);
  await orders(store, halcyon, [], t + 3 * DAY_MS);
  const rebuilt = replay(game);
  assert.deepEqual(rebuilt.world, game.world, "a replay rebuilds the trades and the expiry");
  assert.deepEqual(rebuilt.record, game.record);
}

async function main() {
  await offers();
  await accepting();
  await returning();
  await hits();
  await deletion();
  await showing();
}

main().then(
  () => console.log("trades: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
