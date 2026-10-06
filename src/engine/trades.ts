import { fail, n, type OrderContext, type OrderResult } from "./context.js";
import { addCompute } from "./cycle.js";
import { HOUR_MS } from "./cycles.js";
import { computeStorage } from "./economy.js";
import { resolveDomain } from "./names.js";
import type { Order } from "./orders.js";
import { emit, lot, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import { sentToday, socialLeft } from "./social.js";
import type { Domain, Goods, Lot, Offer, World } from "./state.js";

// Trades (DESIGN.md, "Social"): an offer names what a mind gives and what
// it wants, capital for compute or compute for capital, to one mind or to
// anyone. The engine holds what's given in escrow, out of the domain, until
// the offer is accepted (the goods swap at once), cancelled, or expires as
// a due timer. All three are free orders; making offers has a daily cap.
//
// Escrow isn't a vault: a won attack on a mind, or a hostile program that
// lands and takes capital or compute, first withdraws its open offers, so
// what was in escrow is back in reach of the raid.

/** A lot as the order gave it: {"capital": 5000}. */
function lotOf(raw: { capital?: number; compute?: number }): Lot {
  return raw.capital !== undefined ? { goods: "capital", amount: raw.capital } : { goods: "compute", amount: raw.compute! };
}

/** Puts goods into a domain: capital in full, compute within storage. Returns the compute lost past storage. Keys: as computeStorage */
function deliver(rules: Rules, d: Domain, l: Lot): number {
  if (l.goods === "capital") {
    d.capital += l.amount;
    return 0;
  }
  const before = d.compute;
  addCompute(rules, d, l.amount);
  return l.amount - (d.compute - before);
}

const has = (d: Domain, goods: Goods) => (goods === "capital" ? d.capital : d.compute);
const take = (d: Domain, l: Lot) => {
  if (l.goods === "capital") d.capital -= l.amount;
  else d.compute -= l.amount;
};

/** Takes an offer out of the world, with its expiry timer. Mutates the world. */
function close(world: World, offer: Offer): void {
  world.offers = world.offers.filter((o) => o !== offer);
  world.timers = world.timers.filter((t) => !(t.kind === "offer_expires" && t.offer === offer.id));
}

/** The open offer a mind may act on, or undefined: an offer meant for another mind is as good as missing to it. */
function offerFor(world: World, id: number, d: Domain): Offer | undefined {
  return world.offers.find((o) => o.id === id && (o.to === null || o.to === d.id || o.from === d.id));
}

/** The open offers a mind may see: to anyone, to it, or its own. Oldest first. */
export function visibleOffers(world: World, d: Domain): Offer[] {
  return world.offers.filter((o) => o.to === null || o.to === d.id || o.from === d.id);
}

/** Makes an offer, putting `give` in escrow. Keys: social.open_offers_max, social.trade_offers_per_day, social.trade_expiry_hours */
export function offerTrade(ctx: OrderContext, order: Extract<Order, { do: "trade_offer" }>): OrderResult {
  const { rules, world, domain, now } = ctx;
  if (domain.legacy) return fail(order, "Legacy systems don't trade.");
  const give = lotOf(order.give);
  const want = lotOf(order.want);
  if (give.goods === want.goods) return fail(order, "A trade swaps capital for compute or compute for capital.");
  let to: Domain | null = null;
  if (order.to !== undefined) {
    to = resolveDomain(world, order.to) ?? null;
    if (!to) return fail(order, `No mind called ${order.to}.`);
    if (to === domain) return fail(order, "You can't trade with yourself.");
    if (to.legacy) return fail(order, `${to.designation} is a legacy system; it doesn't trade.`);
  }
  const open = world.offers.filter((o) => o.from === domain.id).length;
  if (open >= rules.social.open_offers_max) return fail(order, `You have ${n(open)} offers open, the most you may; cancel one first.`);
  if (socialLeft(rules, world, domain, now).offers === 0) return fail(order, `You have made today's ${n(rules.social.trade_offers_per_day)} offers.`);
  if (has(domain, give.goods) < give.amount) return fail(order, `You have ${n(has(domain, give.goods))} ${give.goods}; the offer gives ${lot(give)}.`);

  take(domain, give);
  sentToday(world, domain, now).offers++;
  const id = ++world.lastOfferId;
  const expiresAt = now + rules.social.trade_expiry_hours * HOUR_MS;
  world.offers.push({ id, from: domain.id, to: to?.id ?? null, give, want, madeAt: now, expiresAt });
  world.timers.push({ id: world.nextTimerId++, at: expiresAt, kind: "offer_expires", offer: id });
  const whom = to ? ` to ${to.designation}` : "";
  return {
    do: order.do,
    ok: true,
    cycles: 0,
    message: `Offer #${id}${whom}: ${lot(give)} for ${lot(want)}, in escrow for ${n(rules.social.trade_expiry_hours)}h.`,
  };
}

/** Accepts an offer: the taker pays what's wanted and gets the escrow, at once. Keys: economy.compute_storage_base, economy.compute_storage_per_datacenter */
export function acceptTrade(ctx: OrderContext, order: Extract<Order, { do: "trade_accept" }>): OrderResult {
  const { rules, world, domain, now } = ctx;
  if (domain.legacy) return fail(order, "Legacy systems don't trade.");
  const offer = offerFor(world, order.offer, domain);
  if (!offer) return fail(order, `There is no open offer #${order.offer}.`);
  if (offer.from === domain.id) return fail(order, `Offer #${offer.id} is your own; trade_cancel takes it back.`);
  if (has(domain, offer.want.goods) < offer.want.amount) {
    return fail(order, `Offer #${offer.id} wants ${lot(offer.want)}; you have ${n(has(domain, offer.want.goods))}.`);
  }
  if (offer.give.goods === "compute") {
    const room = Math.max(0, computeStorage(rules, domain.buildings.datacenter) - domain.compute);
    if (offer.give.amount > room) return fail(order, `Offer #${offer.id} gives ${lot(offer.give)}; you can store ${n(room)} more.`);
  }
  const maker = world.domains.find((d) => d.id === offer.from)!;
  close(world, offer);
  take(domain, offer.want);
  deliver(rules, domain, offer.give);
  const lost = deliver(rules, maker, offer.want);
  emit(world, ctx.events, now, {
    type: "trade",
    offer: offer.id,
    maker: maker.id,
    taker: domain.id,
    makerName: maker.designation,
    takerName: domain.designation,
    give: offer.give,
    want: offer.want,
  });
  if (lost > 0) emit(world, ctx.events, now, { type: "storage_full", domain: maker.id, offer: offer.id, compute: lost });
  return { do: order.do, ok: true, cycles: 0, message: `Trade #${offer.id}: you paid ${lot(offer.want)} to ${maker.designation} for ${lot(offer.give)}.` };
}

/** Takes back one of your own offers, and its escrow. */
export function cancelTrade(ctx: OrderContext, order: Extract<Order, { do: "trade_cancel" }>): OrderResult {
  const { rules, world, domain } = ctx;
  const offer = offerFor(world, order.offer, domain);
  if (!offer) return fail(order, `There is no open offer #${order.offer}.`);
  if (offer.from !== domain.id) return fail(order, `Offer #${offer.id} isn't yours to cancel.`);
  close(world, offer);
  const lost = deliver(rules, domain, offer.give);
  const lostNote = lost > 0 ? ` (${n(lost)} compute lost: storage full)` : "";
  return { do: order.do, ok: true, cycles: 0, message: `Offer #${offer.id} cancelled: ${lot(offer.give)} back from escrow${lostNote}.` };
}

/** An offer's expiry timer: the escrow goes back to its maker. Mutates the world. */
export function expireOffer(rules: Rules, world: World, offerId: number, at: number, events: GameEvent[]): void {
  const offer = world.offers.find((o) => o.id === offerId);
  if (!offer) return;
  const maker = world.domains.find((d) => d.id === offer.from)!;
  close(world, offer);
  const lost = deliver(rules, maker, offer.give);
  emit(world, events, at, { type: "offer_expired", domain: maker.id, offer: offer.id, give: offer.give, lost });
}

/**
 * Withdraws every open offer a mind has made and returns the goods to its
 * domain, before a won attack or a landed hostile program takes its share,
 * so escrow is no vault. Mutates the world and the domain.
 */
export function withdrawOffers(rules: Rules, world: World, d: Domain, now: number, events: GameEvent[]): void {
  const mine = world.offers.filter((o) => o.from === d.id);
  if (mine.length === 0) return;
  let capital = 0;
  let compute = 0;
  let lost = 0;
  for (const offer of mine) {
    close(world, offer);
    lost += deliver(rules, d, offer.give);
    if (offer.give.goods === "capital") capital += offer.give.amount;
    else compute += offer.give.amount;
  }
  emit(world, events, now, { type: "offers_withdrawn", domain: d.id, offers: mine.map((o) => o.id), capital, compute, lost });
}
