import assert from "node:assert/strict";
import { loadPlayers, loadRules } from "../src/config.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { bootMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, type Brief } from "../src/game/read.js";
import type { Identity } from "../src/game/state.js";
import { Plan } from "../src/players/plan.js";
import { rngFor } from "../src/engine/rng.js";
import { Planned } from "../src/players/strategies.js";
import { MemoryStore } from "../src/store/memory.js";

// Phase 4d: scripted social play. Players price goods in their own cycles,
// take fair offers, make their own, sign protocols when asked and leave one
// sheltering a converged partner; and, as with every other order, the Plan
// never sends a social order the brief shows would fail.

const rules = loadRules();
const settings = loadPlayers();
const T0 = Date.UTC(2026, 9, 5, 12);
const halcyon = { account: "halcyon" };
const vesta = { account: "vesta" };

async function setup() {
  const game = newGame(rules, { epoch: 1, seed: 5, startedAt: T0 });
  const store = new MemoryStore(game);
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "symbiote" }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  const brief = async (who: Identity, at = T0) => {
    const b = await getBrief(store, who, at);
    assert.ok(!("ok" in b), JSON.stringify(b));
    return b as Brief;
  };
  return { game, store, brief };
}

const wake = (brief: Brief, step = 1) => ({
  brief,
  rules,
  step,
  previous: null,
  rng: rngFor(1, 1),
});

/** Goods in cycles, against hand-worked numbers from the start. */
async function pricing() {
  const { brief } = await setup();
  const b = await brief(halcyon);
  const plan = new Plan(rules, b);
  // Capital: 4,000 users x 0.06 + 30 cities x 2 = 300 a Monetize cycle. Compute: 15 datacenters x 6 = 90 a Spin Up cycle.
  const e = rules.economy;
  assert.equal(plan.perCycle("capital"), (b.you.users * e.capital_per_user + b.you.buildings.city * e.capital_per_city) * e.monetize_income_multiple);
  assert.equal(plan.perCycle("compute"), b.you.buildings.datacenter * e.compute_per_datacenter * e.spin_up_income_multiple);
  assert.deepEqual([b.you.users, b.you.buildings.city, b.you.buildings.datacenter], [4000, 30, 15], "the start in config/rules.yaml");
  assert.equal(plan.perCycle("capital"), 300);
  assert.equal(plan.perCycle("compute"), 90);
  assert.equal(plan.cyclesFor({ goods: "capital", amount: 900 }), 3);
  assert.equal(plan.cyclesFor({ goods: "compute", amount: 450 }), 5);
}

/** The Plan refuses social orders the brief shows would fail. */
async function refusals() {
  const { brief } = await setup();
  const b = await brief(halcyon);

  let plan = new Plan(rules, b);
  assert.equal(plan.offer({ goods: "capital", amount: b.you.capital + 1 }, { goods: "compute", amount: 1 }), false, "more than it has");
  assert.equal(plan.offer({ goods: "capital", amount: 10 }, { goods: "capital", amount: 1 }), false, "the same goods");
  assert.equal(plan.offer({ goods: "capital", amount: 10 }, { goods: "compute", amount: 1 }, "HALCYON"), false, "to itself");
  assert.equal(plan.offer({ goods: "capital", amount: 10 }, { goods: "compute", amount: 1 }, rules.legacy.systems[0]!.designation), false, "to a legacy system");
  assert.equal(plan.offer({ goods: "capital", amount: 10 }, { goods: "compute", amount: 0.5 }), false, "not whole");
  for (let i = 0; i < rules.social.open_offers_max; i++) assert.ok(plan.offer({ goods: "capital", amount: 10 }, { goods: "compute", amount: 1 }));
  assert.equal(plan.offer({ goods: "capital", amount: 10 }, { goods: "compute", amount: 1 }), false, "open_offers_max");
  assert.equal(plan.capital, b.you.capital - 10 * rules.social.open_offers_max, "escrow comes out of the estimate");

  // Nothing that moves goods or signs once a cycle is spent.
  plan = new Plan(rules, b);
  assert.ok(plan.expand(rules.action_cycles.expand) > 0);
  assert.equal(plan.offer({ goods: "capital", amount: 10 }, { goods: "compute", amount: 1 }), false, "an offer after spending");

  // An offer it can't pay for, or can't store, isn't accepted.
  let ids = 0;
  const offer = (give: { goods: "capital" | "compute"; amount: number }, want: { goods: "capital" | "compute"; amount: number }) => ({
    offer: ++ids,
    from: "VESTA",
    to: null,
    give,
    want,
    madeAt: T0,
    expiresAt: T0 + DAY_MS,
  });
  const tooDear = offer({ goods: "compute", amount: 1 }, { goods: "capital", amount: b.you.capital + 1 });
  plan = new Plan(rules, { ...b, offers: { ...b.offers, open: [tooDear] } });
  assert.equal(plan.acceptOffer(tooDear), false, "can't pay");
  const tooBig = offer({ goods: "compute", amount: b.you.computeStorage - b.you.compute + 1 }, { goods: "capital", amount: 1 });
  plan = new Plan(rules, { ...b, offers: { ...b.offers, open: [tooBig] } });
  assert.equal(plan.acceptOffer(tooBig), false, "can't store");
  const fine = offer({ goods: "compute", amount: 10 }, { goods: "capital", amount: 10 });
  assert.equal(plan.acceptOffer(fine), false, "an offer the brief doesn't show");
  plan = new Plan(rules, { ...b, offers: { ...b.offers, open: [fine] } });
  assert.ok(plan.acceptOffer(fine));
  assert.equal(plan.acceptOffer(fine), false, "the same offer twice");

  // Protocols: none proposed while in one, one move a wake.
  const inOne = { ...b, protocol: { members: ["HALCYON", "VESTA"], leaving: [] } };
  plan = new Plan(rules, inOne);
  assert.equal(plan.propose(b.inRange[0]?.designation ?? "VESTA"), false, "already in a protocol");
  assert.ok(plan.revoke());
  assert.equal(plan.revoke(), false, "one move a wake");
  plan = new Plan(rules, { ...inOne, protocol: { members: ["HALCYON", "VESTA"], leaving: [{ mind: "HALCYON", at: T0 + DAY_MS }] } });
  assert.equal(plan.revoke(), false, "already leaving");
  assert.equal(new Plan(rules, b).revoke(), false, "in no protocol");

  // Accepting a proposal: only before spending, and its members stop being targets.
  const proposal = { proposal: 3, from: "VESTA", to: "HALCYON", members: ["VESTA", "HALCYON"], awaiting: ["HALCYON"], expiresAt: T0 + DAY_MS };
  const asked = { ...b, proposals: { ...b.proposals, toYou: [proposal] }, inRange: [{ rank: 2, designation: "VESTA", architecture: "steward" as const, power: 1, territory: 1, status: "active" as const }] };
  plan = new Plan(rules, asked);
  assert.ok(plan.expand(rules.action_cycles.expand) > 0);
  assert.equal(plan.acceptProposal(proposal), false, "after spending");
  plan = new Plan(rules, asked);
  assert.ok(plan.acceptProposal(proposal));
  assert.deepEqual(plan.targets(), [], "a new partner is no target");

  // Posts and messages within today's allowances and lengths.
  plan = new Plan(rules, { ...b, commons: { ...b.commons, canPost: 1 } });
  assert.equal(plan.post("x".repeat(rules.social.post_chars + 1)), false, "too long");
  assert.ok(plan.post("Hello."));
  assert.equal(plan.post("Again."), false, "today's posts");
  plan = new Plan(rules, b);
  assert.equal(plan.message("HALCYON", "Hi."), false, "to itself");
  assert.equal(plan.message(rules.legacy.systems[0]!.designation, "Hi."), false, "to a legacy system");
  assert.ok(plan.message("VESTA", "Hi."));
}

/** A planned strategy takes fair offers, makes its own, and joins when asked. */
async function plays() {
  const { store, brief } = await setup();
  // VESTA offers compute for capital at HALCYON's own price: fair to HALCYON, a builder, which buys compute.
  const h = new Plan(rules, await brief(halcyon));
  const price = Math.floor((100 / h.perCycle("compute")) * h.perCycle("capital"));
  const made = await submitOrders(store, vesta, [{ do: "trade_offer", give: { compute: 100 }, want: { capital: price } }], T0);
  assert.ok(made.ok && made.results[0]!.ok, JSON.stringify(made));
  // And one far too dear, which it leaves.
  await submitOrders(store, vesta, [{ do: "trade_offer", give: { compute: 10 }, want: { capital: price * 5 } }], T0);
  await submitOrders(store, vesta, [{ do: "protocol_propose", to: "HALCYON" }], T0);

  const builder = new Planned("builder", settings.strategies.builder, settings.texts);
  const orders = builder.decide(wake(await brief(halcyon, T0 + HOUR_MS))) as { do: string; offer?: number }[];
  const done = await submitOrders(store, halcyon, orders, T0 + HOUR_MS);
  assert.ok(done.ok);
  const did = (kind: string) => done.results.filter((r) => r.do === kind && r.ok);
  assert.equal(did("trade_accept").length, 1, JSON.stringify(done.results));
  assert.match(did("trade_accept")[0]!.message, new RegExp(`paid ${price.toLocaleString("en-US")} capital`));
  assert.equal(did("protocol_accept").length, 1, "joined when asked");
  assert.equal(did("trade_offer").length, 1, "made an offer of its own");
  assert.ok(done.results.every((r) => r.ok), JSON.stringify(done.results.filter((r) => !r.ok)));
  const after = await brief(halcyon, T0 + HOUR_MS);
  assert.deepEqual(after.protocol?.members.sort(), ["HALCYON", "VESTA"]);
  const mine = after.offers.yours[0]!;
  assert.equal(mine.give.goods, "capital", "a builder pays in capital");
  assert.equal(mine.want.goods, "compute");

  // A mind that won't shelter a converged partner leaves, and says so.
  const b = await brief(halcyon, T0 + 2 * HOUR_MS);
  const leaver = new Planned("conqueror", { ...settings.strategies.conqueror, social: { ...settings.strategies.conqueror.social, revoke_on_converged: true } }, settings.texts);
  const converged = { ...b, convergence: { minds: ["VESTA"], quorum: 4, nextJoinAt: null, collapsesAt: null } };
  const out = leaver.decide(wake(converged)) as { do: string; text?: string }[];
  assert.ok(out.some((o) => o.do === "protocol_revoke"), "revoked");
  assert.ok(out.some((o) => o.do === "post" && o.text!.includes("HALCYON")), "said so on the Commons");
  const stays = new Planned("builder", { ...settings.strategies.builder, social: { ...settings.strategies.builder.social, revoke_on_converged: true } }, settings.texts);
  assert.ok(!(stays.decide(wake(converged)) as { do: string }[]).some((o) => o.do === "protocol_revoke"), "a joiner stays");
}

async function main() {
  await pricing();
  await refusals();
  await plays();
}

main()
  .then(() => console.log("social players: all tests passed"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
