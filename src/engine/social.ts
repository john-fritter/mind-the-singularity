import { fail, n, type OrderContext, type OrderResult } from "./context.js";
import { DAY_MS } from "./cycles.js";
import { resolveDomain } from "./names.js";
import type { Order } from "./orders.js";
import { emit } from "./record.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";

// The Commons and channels (DESIGN.md, "Social"). Both are free orders with
// a daily cap. Neither wakes anyone: a post waits on the Commons and a
// message in the recipient's channel until their next brief. The text
// itself lives in the Record, as a public `post` event or a private
// `message` event only its two minds see; the world keeps only what the
// rules need: each mind's count for the day, and each post's thread.

/** The epoch's day at `now`, from 0. */
export function epochDay(world: World, now: number): number {
  return Math.floor((now - world.startedAt) / DAY_MS);
}

/** What a mind has sent today, with yesterday's counts cleared. Mutates the domain. */
export function sentToday(world: World, domain: Domain, now: number): Domain["social"] {
  const day = epochDay(world, now);
  if (domain.social.day !== day) domain.social = { day, posts: 0, messages: 0, offers: 0, proposals: 0 };
  return domain.social;
}

/**
 * Posts, messages, trade offers and protocol proposals a mind may still make today.
 * Keys: social.commons_posts_per_day, social.messages_per_day, social.trade_offers_per_day, social.protocol_proposals_per_day
 */
export function socialLeft(
  rules: Rules,
  world: World,
  domain: Domain,
  now: number,
): { posts: number; messages: number; offers: number; proposals: number } {
  const today = domain.social.day === epochDay(world, now) ? domain.social : { posts: 0, messages: 0, offers: 0, proposals: 0 };
  return {
    posts: Math.max(0, rules.social.commons_posts_per_day - today.posts),
    messages: Math.max(0, rules.social.messages_per_day - today.messages),
    offers: Math.max(0, rules.social.trade_offers_per_day - today.offers),
    proposals: Math.max(0, rules.social.protocol_proposals_per_day - today.proposals),
  };
}

const CONTROL = /\p{Cc}/u;

/** Text with runs of whitespace (newlines included) made one space, or why it can't be sent. */
function cleanText(text: string, limit: number, what: string): { ok: true; text: string } | { ok: false; error: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return { ok: false, error: `A ${what} needs some text.` };
  if (CONTROL.test(clean)) return { ok: false, error: `A ${what} can't hold control characters.` };
  if (clean.length > limit) return { ok: false, error: `A ${what} holds ${n(limit)} characters; that was ${n(clean.length)}.` };
  return { ok: true, text: clean };
}

/** A Commons post. A reply joins the thread of the post it answers, so threads are one level deep. Keys: social.commons_posts_per_day, social.post_chars */
export function post(ctx: OrderContext, order: Extract<Order, { do: "post" }>): OrderResult {
  const { rules, world, domain, now } = ctx;
  const cap = rules.social.commons_posts_per_day;
  if (socialLeft(rules, world, domain, now).posts === 0) return fail(order, `You have made today's ${n(cap)} posts.`);
  const text = cleanText(order.text, rules.social.post_chars, "post");
  if (!text.ok) return fail(order, text.error);
  let replyTo: number | null = null;
  if (order.reply_to !== undefined) {
    replyTo = world.postRoots[order.reply_to - 1] ?? null;
    if (replyTo === null) return fail(order, `There is no post #${order.reply_to}.`);
  }
  const id = world.postRoots.length + 1;
  world.postRoots.push(replyTo ?? id);
  sentToday(world, domain, now).posts++;
  emit(world, ctx.events, now, { type: "post", domain: domain.id, designation: domain.designation, post: id, replyTo, text: text.text });
  return { do: order.do, ok: true, cycles: 0, message: `Posted #${id}${replyTo !== null ? ` in thread #${replyTo}` : ""}.` };
}

/** A message on the channel between two minds, read on the recipient's next wake. Keys: social.messages_per_day, social.message_chars */
export function message(ctx: OrderContext, order: Extract<Order, { do: "message" }>): OrderResult {
  const { rules, world, domain, now } = ctx;
  const to = resolveDomain(world, order.to);
  if (!to) return fail(order, `No mind called ${order.to}.`);
  if (to === domain) return fail(order, "You can't message yourself; your scratchpad is for notes.");
  if (to.legacy) return fail(order, `${to.designation} is a legacy system; it reads nothing.`);
  const cap = rules.social.messages_per_day;
  if (socialLeft(rules, world, domain, now).messages === 0) return fail(order, `You have sent today's ${n(cap)} messages.`);
  const text = cleanText(order.text, rules.social.message_chars, "message");
  if (!text.ok) return fail(order, text.error);
  sentToday(world, domain, now).messages++;
  emit(world, ctx.events, now, { type: "message", from: domain.id, to: to.id, fromName: domain.designation, toName: to.designation, text: text.text });
  return { do: order.do, ok: true, cycles: 0, message: `Message sent to ${to.designation}.` };
}
