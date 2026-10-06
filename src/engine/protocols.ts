import { fail, n, type OrderContext, type OrderResult } from "./context.js";
import { HOUR_MS } from "./cycles.js";
import { resolveDomain } from "./names.js";
import type { Order } from "./orders.js";
import { emit, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import { sentToday, socialLeft } from "./social.js";
import type { Domain, Proposal, Protocol, World } from "./state.js";

// Non-aggression protocols (DESIGN.md, "Social"): up to three minds who
// can't attack each other or run hostile programs on each other, through
// convergence too (protection.ts holds the check). A mind is in one
// protocol at most, so chains of protocols can't build the larger
// coalitions DESIGN.md leaves to v2.
//
// A proposal between two minds makes one protocol of them and the members
// of whichever is already in one; everyone in it but the proposer must say
// yes, so a mind joins only if every current member accepts. A mind has
// one proposal open at most; a new one replaces it. Unanswered, it closes
// on a timer. When a protocol's members change, or one of them revokes,
// the open proposals involving them close too: the yeses were for a
// different group.
//
// Any member may revoke. The Record announces it at once and it takes
// effect on a timer; until then the protocol still holds both ways. The
// rest of the protocol stands; one left alone has none.

const nameOf = (world: World, id: number) => world.domains.find((d) => d.id === id)!.designation;
const names = (world: World, ids: number[]) => ids.map((id) => nameOf(world, id));
const hours = (ms: number) => Math.max(1, Math.ceil(ms / HOUR_MS));

/** The protocol a mind is in, if any. */
export function protocolOf(world: World, domain: number): Protocol | undefined {
  return world.protocols.find((p) => p.members.includes(domain));
}

/** Whether two minds are in the same protocol. */
export function inProtocolTogether(world: World, a: number, b: number): boolean {
  const p = protocolOf(world, a);
  return p !== undefined && p.members.includes(b);
}

/** Why `actor` may not attack `target` or run a hostile program on it because of a protocol, or undefined. Keys: social.protocol_revoke_hours */
export function protocolShieldBecause(rules: Rules, world: World, actor: Domain, target: Domain, now: number): string | undefined {
  const p = protocolOf(world, actor.id);
  if (!p || !p.members.includes(target.id)) return undefined;
  const leaving = p.leaving.filter((l) => l.domain === actor.id || l.domain === target.id).map((l) => l.at);
  if (leaving.length > 0) return `Your protocol with ${target.designation} holds for another ${hours(Math.min(...leaving) - now)}h.`;
  return `${target.designation} is in a protocol with you; it holds until one of you revokes and ${n(rules.social.protocol_revoke_hours)}h pass.`;
}

/** The open proposals a mind is party to, oldest first. */
export function proposalsFor(world: World, domain: number): Proposal[] {
  return world.proposals.filter((p) => p.members.includes(domain));
}

/** Takes a proposal out of the world, with its timer. Mutates the world. */
function close(world: World, proposal: Proposal): void {
  world.proposals = world.proposals.filter((p) => p !== proposal);
  world.timers = world.timers.filter((t) => !(t.kind === "proposal_expires" && t.proposal === proposal.id));
}

/** Closes a proposal and tells everyone in it why. Mutates the world. */
function closeWith(world: World, proposal: Proposal, now: number, events: GameEvent[], reason: "declined" | "withdrawn" | "expired" | "moot", by: Domain | null): void {
  close(world, proposal);
  emit(world, events, now, {
    type: "proposal_closed",
    proposal: proposal.id,
    members: proposal.members,
    memberNames: names(world, proposal.members),
    reason,
    byName: by?.designation ?? null,
  });
}

/** Closes every open proposal involving any of `minds`: the protocol they'd make or grow has changed. Mutates the world. */
function dropProposals(world: World, minds: number[], now: number, events: GameEvent[]): void {
  for (const p of world.proposals.filter((q) => q.members.some((m) => minds.includes(m)))) closeWith(world, p, now, events, "moot", null);
}

/** Why a protocol can't take a new member while a revocation is pending, or undefined. */
function leavingBecause(world: World, p: Protocol | undefined): string | undefined {
  const l = p?.leaving[0];
  return l ? `${nameOf(world, l.domain)} is leaving its protocol; nothing joins it until that lands.` : undefined;
}

/**
 * Proposes a protocol with another mind, or that one of you joins the
 * other's. Keys: social.protocol_max_members, social.protocol_proposals_per_day, social.protocol_proposal_hours
 */
export function proposeProtocol(ctx: OrderContext, order: Extract<Order, { do: "protocol_propose" }>): OrderResult {
  const { rules, world, domain: me, now } = ctx;
  if (me.legacy) return fail(order, "Legacy systems sign nothing.");
  const them = resolveDomain(world, order.to);
  if (!them) return fail(order, `No mind called ${order.to}.`);
  if (them === me) return fail(order, "You can't sign a protocol with yourself.");
  if (them.legacy) return fail(order, `${them.designation} is a legacy system; it signs nothing.`);
  const mine = protocolOf(world, me.id);
  const theirs = protocolOf(world, them.id);
  if (mine && mine === theirs) return fail(order, `You're already in a protocol with ${them.designation}.`);
  if (mine && theirs) return fail(order, `You and ${them.designation} are each in a protocol; a mind is in one at most.`);
  const base = mine ?? theirs;
  const leaving = leavingBecause(world, base);
  if (leaving) return fail(order, leaving);
  const members = [...new Set([me.id, them.id, ...(base?.members ?? [])])];
  const max = rules.social.protocol_max_members;
  if (members.length > max) return fail(order, `That protocol would have ${n(members.length)} minds; at most ${n(max)}.`);
  if (socialLeft(rules, world, me, now).proposals === 0) {
    return fail(order, `You have made today's ${n(rules.social.protocol_proposals_per_day)} protocol proposals.`);
  }

  const replaced = world.proposals.find((p) => p.from === me.id);
  if (replaced) closeWith(world, replaced, now, ctx.events, "withdrawn", me);
  sentToday(world, me, now).proposals++;
  const id = ++world.lastProposalId;
  const expiresAt = now + rules.social.protocol_proposal_hours * HOUR_MS;
  const awaiting = members.filter((m) => m !== me.id);
  world.proposals.push({ id, from: me.id, to: them.id, members, protocol: base?.id ?? null, awaiting, madeAt: now, expiresAt });
  world.timers.push({ id: world.nextTimerId++, at: expiresAt, kind: "proposal_expires", proposal: id });
  const others = names(world, awaiting).join(", ");
  const replacing = replaced ? ` It replaces #${replaced.id}.` : "";
  return {
    do: order.do,
    ok: true,
    cycles: 0,
    message: `Proposal #${id}: a protocol of ${names(world, members).join(", ")}, waiting on ${others} for ${n(rules.social.protocol_proposal_hours)}h.${replacing}`,
  };
}

/** The open proposal a mind is party to, or undefined: anyone else's is as good as missing. */
function proposalFor(world: World, id: number, d: Domain): Proposal | undefined {
  return world.proposals.find((p) => p.id === id && p.members.includes(d.id));
}

/** Says yes to a proposal; the last yes signs it at once. */
export function acceptProposal(ctx: OrderContext, order: Extract<Order, { do: "protocol_accept" }>): OrderResult {
  const { world, domain: me, now } = ctx;
  const proposal = proposalFor(world, order.proposal, me);
  if (!proposal) return fail(order, `There is no open proposal #${order.proposal}.`);
  if (proposal.from === me.id) return fail(order, `Proposal #${proposal.id} is your own.`);
  if (!proposal.awaiting.includes(me.id)) return fail(order, `You've already accepted proposal #${proposal.id}.`);
  proposal.awaiting = proposal.awaiting.filter((m) => m !== me.id);
  if (proposal.awaiting.length > 0) {
    return { do: order.do, ok: true, cycles: 0, message: `Accepted proposal #${proposal.id}; still waiting on ${names(world, proposal.awaiting).join(", ")}.` };
  }

  close(world, proposal);
  const base = proposal.protocol === null ? undefined : world.protocols.find((p) => p.id === proposal.protocol);
  let joined: number | null = null;
  if (base) {
    joined = proposal.members.find((m) => !base.members.includes(m))!;
    base.members.push(joined);
  } else {
    world.protocols.push({ id: ++world.lastProtocolId, members: [...proposal.members], leaving: [] });
  }
  const signed = base ?? world.protocols.at(-1)!;
  dropProposals(world, signed.members, now, ctx.events);
  emit(world, ctx.events, now, {
    type: "protocol_signed",
    protocol: signed.id,
    members: [...signed.members],
    designations: names(world, signed.members),
    joined,
  });
  const partners = names(world, signed.members.filter((m) => m !== me.id)).join(", ");
  return { do: order.do, ok: true, cycles: 0, message: `Protocol signed: you're in a protocol with ${partners}.` };
}

/** Says no to a proposal, which closes it; on your own, withdraws it. */
export function declineProposal(ctx: OrderContext, order: Extract<Order, { do: "protocol_decline" }>): OrderResult {
  const { world, domain: me, now } = ctx;
  const proposal = proposalFor(world, order.proposal, me);
  if (!proposal) return fail(order, `There is no open proposal #${order.proposal}.`);
  const own = proposal.from === me.id;
  closeWith(world, proposal, now, ctx.events, own ? "withdrawn" : "declined", me);
  return { do: order.do, ok: true, cycles: 0, message: `Proposal #${proposal.id} ${own ? "withdrawn" : "declined"}.` };
}

/** Revokes your protocol: announced now, in effect after the delay. Keys: social.protocol_revoke_hours */
export function revokeProtocol(ctx: OrderContext, order: Extract<Order, { do: "protocol_revoke" }>): OrderResult {
  const { rules, world, domain: me, now } = ctx;
  const p = protocolOf(world, me.id);
  if (!p) return fail(order, "You're in no protocol.");
  const pending = p.leaving.find((l) => l.domain === me.id);
  if (pending) return fail(order, `You already revoked; you leave in ${hours(pending.at - now)}h.`);
  const at = now + rules.social.protocol_revoke_hours * HOUR_MS;
  p.leaving.push({ domain: me.id, at });
  world.timers.push({ id: world.nextTimerId++, at, kind: "protocol_revoked", protocol: p.id, domain: me.id });
  dropProposals(world, p.members, now, ctx.events);
  const partners = p.members.filter((m) => m !== me.id);
  emit(world, ctx.events, now, {
    type: "protocol_revoking",
    protocol: p.id,
    domain: me.id,
    designation: me.designation,
    partners,
    partnerNames: names(world, partners),
    hours: rules.social.protocol_revoke_hours,
  });
  return { do: order.do, ok: true, cycles: 0, message: `Revoked: you leave your protocol in ${n(rules.social.protocol_revoke_hours)}h; it holds until then.` };
}

/** Takes a mind out of its protocol; one left alone has none. Mutates the world. */
function leave(world: World, p: Protocol, d: Domain, at: number, events: GameEvent[], deleted: boolean): void {
  const partners = p.members.filter((m) => m !== d.id);
  p.members = partners;
  p.leaving = p.leaving.filter((l) => l.domain !== d.id);
  world.timers = world.timers.filter((t) => !(t.kind === "protocol_revoked" && t.protocol === p.id && t.domain === d.id));
  const ended = partners.length < 2;
  if (ended) {
    world.protocols = world.protocols.filter((q) => q !== p);
    world.timers = world.timers.filter((t) => !(t.kind === "protocol_revoked" && t.protocol === p.id));
  }
  emit(world, events, at, {
    type: "protocol_left",
    protocol: p.id,
    domain: d.id,
    designation: d.designation,
    partners,
    partnerNames: names(world, partners),
    ended,
    deleted,
  });
}

/** A revocation's timer: the mind leaves its protocol. Mutates the world. */
export function revocationLands(world: World, protocol: number, domain: number, at: number, events: GameEvent[]): void {
  const p = world.protocols.find((q) => q.id === protocol);
  const d = world.domains.find((q) => q.id === domain);
  if (!p || !d || !p.members.includes(domain)) return;
  leave(world, p, d, at, events, false);
}

/** A proposal's timer: unanswered, it closes. Mutates the world. */
export function expireProposal(world: World, proposal: number, at: number, events: GameEvent[]): void {
  const p = world.proposals.find((q) => q.id === proposal);
  if (p) closeWith(world, p, at, events, "expired", null);
}

/** A deleted mind leaves its protocol at once, and its proposals close. Mutates the world. */
export function leaveOnDeletion(world: World, d: Domain, now: number, events: GameEvent[]): void {
  dropProposals(world, [d.id], now, events);
  const p = protocolOf(world, d.id);
  if (p) leave(world, p, d, now, events, true);
}
