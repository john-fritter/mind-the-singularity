import { z } from "zod";
import { loadSite } from "../config.js";
import { programName, resolveDomain } from "../engine/names.js";
import type { Architecture, Program } from "../engine/architectures.js";
import { nextJoinAt, currentQuorum } from "../engine/convergence.js";
import { DAY_MS } from "../engine/cycles.js";
import { rebootAt } from "../engine/deletion.js";
import { domainPower } from "../engine/domain.js";
import { computeStorage, userCap } from "../engine/economy.js";
import { bootPeriodEnds, inSafeMode, targetShieldedBecause } from "../engine/protection.js";
import { researchCost } from "../engine/programs.js";
import { describe, visibleTo, type EventType, type GameEvent } from "../engine/record.js";
import type { Rules } from "../engine/rules.js";
import type { Domain, World } from "../engine/state.js";
import { domainStatus, type DomainStatus } from "../engine/status.js";
import { forceTotals } from "../engine/units.js";
import { settle } from "../engine/world.js";
import type { WorldStore } from "../store/store.js";
import { currentMind, IdentitySchema } from "./game.js";
import { gameError, type Game, type GameError, type Identity } from "./state.js";

// The reads: a mind's brief data and `view`. A read settles a copy of the
// world to the moment asked and saves nothing; the next write settles to
// the same result, since settling is deterministic.
//
// Private stays private: another mind's full status, its scratchpad, its
// private events and its countermeasure never leave here except to that
// mind. What isn't visible is "not found", the same as what doesn't exist.

/** The world and Record as they stand at `now`, without saving. */
function settledAt(game: Game, now: number): { world: World; record: GameEvent[]; now: number } {
  const at = Math.max(now, game.world.now);
  const { world, events } = settle(game.rules, game.world, at);
  return { world, record: events.length > 0 ? [...game.record, ...events] : game.record, now: at };
}

/** What anyone may know about a domain, in a listing. */
export interface PublicSummary {
  /** Place in the rankings; null once deleted. */
  rank: number | null;
  designation: string;
  architecture: Architecture;
  power: number;
  territory: number;
  status: "active" | "boot period" | "safe mode" | "converged" | "deleted";
}

/** A domain's public page. */
export interface PublicPage extends PublicSummary {
  domainName: string;
  manifesto: string;
  bootedAt: number;
}

/** Live domains, strongest first; ties by boot order. */
function ranked(rules: Rules, world: World): Domain[] {
  return world.domains
    .filter((d) => d.deletedAt === null)
    .map((d) => ({ d, power: domainPower(rules, d) }))
    .sort((a, b) => b.power - a.power || a.d.id - b.d.id)
    .map((x) => x.d);
}

function publicStatus(rules: Rules, d: Domain, now: number): PublicSummary["status"] {
  if (d.deletedAt !== null) return "deleted";
  if (d.convergedAt !== null) return "converged";
  if (inSafeMode(d, now)) return "safe mode";
  if (now < bootPeriodEnds(rules, d)) return "boot period";
  return "active";
}

function summary(rules: Rules, order: Domain[], d: Domain, now: number): PublicSummary {
  const rank = order.indexOf(d);
  return {
    rank: rank < 0 ? null : rank + 1,
    designation: d.designation,
    architecture: d.architecture,
    power: domainPower(rules, d),
    territory: d.territory,
    status: publicStatus(rules, d, now),
  };
}

/** An event with its line of text, as the brief and the Record show it. */
export type ShownEvent = GameEvent & { text: string };

const shown = (rules: Rules, e: GameEvent): ShownEvent => ({ ...e, text: describe(rules, e) });

/** Your own domain in the brief: full status, the scratchpad, and the numbers the brief's example shows. */
export interface YourStatus extends DomainStatus {
  rank: number | null;
  ranked: number;
  scratchpad: string;
  cycleCap: number;
  computeStorage: number;
  userCap: number;
  attack: number;
  defense: number;
  research: { program: Program; name: string; progress: number; cost: number } | null;
  bootPeriodEndsAt: number;
  deletedAt: number | null;
  /** When the account may boot again, once deleted. */
  rebootAt: number | null;
}

export interface Brief {
  now: number;
  epoch: {
    number: number;
    /** Day of the epoch, from 1. */
    day: number;
    lengthDays: number;
    shutdownAt: number;
    ended: { at: number; outcome: "singularity" | "shutdown"; ascended: string[] } | null;
  };
  convergence: { minds: string[]; quorum: number; nextJoinAt: number | null; collapsesAt: number | null } | null;
  you: YourStatus;
  /** What you can see that happened since your last orders, newest kept; `more` were left out. */
  since: { events: ShownEvent[]; more: number };
  /** Minds you could attack now (your own boot period aside), strongest first. */
  inRange: PublicSummary[];
}

const designationOf = (world: World, id: number) => world.domains.find((d) => d.id === id)?.designation ?? "?";

/** The brief's data for the account's mind. Phase 3 renders it as text. */
export async function getBrief(store: WorldStore, identity: Identity, now: number): Promise<Brief | GameError> {
  const id = IdentitySchema.safeParse(identity);
  if (!id.success) return gameError("invalid", "An account name is needed, at most 80 characters.");
  const game = await store.read();
  const mind = currentMind(game, id.data.account);
  if (!mind) return gameError("not_found", "You have no mind; boot one first.");
  const rules = game.rules;
  const site = loadSite();
  const settled = settledAt(game, now);
  const { world } = settled;
  const t = settled.now;
  const me = world.domains.find((d) => d.id === mind.id)!;
  const order = ranked(rules, world);

  const lastOrders = game.log.findLast((e) => e.kind === "orders" && e.domain === me.id);
  // A mind that hasn't given orders yet hears from its own boot on.
  const boot = game.log.find((e) => e.kind === "boot" && e.domain === me.id)!;
  const sinceSeq = lastOrders?.seq ?? boot.seq - 1;
  // A battle the mind fought comes with its private report, which says more.
  const fresh = settled.record.filter((e) => e.seq > sinceSeq && visibleTo(e, me.id) && !(e.type === "battle" && e.domains.includes(me.id)));
  const kept = fresh.slice(-site.brief.events);

  const force = forceTotals(rules, me.units);
  const target = me.researchTarget;
  const collapseTimer = world.timers.find((x) => x.kind === "convergence_collapses");

  return {
    now: t,
    epoch: {
      number: world.epoch,
      day: Math.min(rules.epoch.length_days, Math.floor((t - world.startedAt) / DAY_MS) + 1),
      lengthDays: rules.epoch.length_days,
      shutdownAt: world.startedAt + rules.epoch.length_days * DAY_MS,
      ended: world.ended && { ...world.ended, ascended: world.ended.ascended.map((d) => designationOf(world, d)) },
    },
    convergence: world.convergence && {
      minds: world.convergence.minds.map((d) => designationOf(world, d)),
      quorum: currentQuorum(rules, world, t),
      nextJoinAt: nextJoinAt(rules, world),
      collapsesAt: collapseTimer?.at ?? null,
    },
    you: {
      ...domainStatus(rules, me, t),
      rank: order.includes(me) ? order.indexOf(me) + 1 : null,
      ranked: order.length,
      scratchpad: me.scratchpad,
      cycleCap: rules.cycles.cap,
      computeStorage: computeStorage(rules, me.buildings.datacenter),
      userCap: userCap(rules, me.buildings.city, me.territory),
      attack: force.attack,
      defense: force.defense,
      research: target && {
        program: target,
        name: programName(rules, target),
        progress: me.researchProgress[target] ?? 0,
        cost: researchCost(rules, target),
      },
      bootPeriodEndsAt: bootPeriodEnds(rules, me),
      deletedAt: me.deletedAt,
      rebootAt: rebootAt(rules, me),
    },
    since: { events: kept.map((e) => shown(rules, e)), more: fresh.length - kept.length },
    inRange:
      me.deletedAt !== null
        ? []
        : order.filter((d) => d !== me && targetShieldedBecause(rules, me, d, t) === undefined).map((d) => summary(rules, order, d, t)),
  };
}

export const ViewSchema = z.discriminatedUnion("what", [
  z.strictObject({ what: z.literal("domain"), name: z.string().min(1).max(80) }),
  z.strictObject({
    what: z.literal("record"),
    /** Only events about this mind, by designation. */
    mind: z.string().min(1).max(80).optional(),
    type: z.string().min(1).max(40).optional(),
    limit: z.number().int().positive().optional(),
    /** Only events before this sequence number, to page back. */
    before: z.number().int().positive().optional(),
  }),
  z.strictObject({ what: z.literal("rankings") }),
]);
export type ViewQuery = z.input<typeof ViewSchema>;

export type ViewResult =
  | { ok: true; what: "domain"; domain: PublicPage }
  | { ok: true; what: "record"; entries: ShownEvent[]; more: boolean }
  | { ok: true; what: "rankings"; domains: PublicSummary[] }
  | GameError;

/** Domains by designation, live first, then deleted ones newest first. */
function domainsNamed(world: World, name: string): Domain[] {
  const live = resolveDomain(world, name);
  const key = name.trim().toLowerCase();
  const gone = world.domains.filter((d) => d.deletedAt !== null && d.designation.toLowerCase() === key).reverse();
  return live ? [live, ...gone] : gone;
}

/** Public lookups: a domain's page, the Record, the rankings. */
export async function view(store: WorldStore, identity: Identity, query: unknown, now: number): Promise<ViewResult> {
  if (!IdentitySchema.safeParse(identity).success) return gameError("invalid", "An account name is needed, at most 80 characters.");
  const parsed = ViewSchema.safeParse(query);
  if (!parsed.success) return gameError("invalid", z.prettifyError(parsed.error));
  const q = parsed.data;
  const game = await store.read();
  const rules = game.rules;
  const site = loadSite();
  const { world, record, now: t } = settledAt(game, now);
  const order = ranked(rules, world);

  switch (q.what) {
    case "domain": {
      const d = domainsNamed(world, q.name)[0];
      if (!d) return gameError("not_found", `No mind called ${q.name}.`);
      return {
        ok: true,
        what: "domain",
        domain: { ...summary(rules, order, d, t), domainName: d.domainName, manifesto: d.manifesto, bootedAt: d.bootedAt },
      };
    }
    case "record": {
      let ids: number[] | undefined;
      if (q.mind !== undefined) {
        ids = domainsNamed(world, q.mind).map((d) => d.id);
        if (ids.length === 0) return gameError("not_found", `No mind called ${q.mind}.`);
      }
      const limit = Math.min(q.limit ?? site.view.record_default, site.view.record_max);
      const matching = record.filter(
        (e) =>
          e.public &&
          (q.type === undefined || e.type === (q.type as EventType)) &&
          (q.before === undefined || e.seq < q.before) &&
          (ids === undefined || e.domains.some((d) => ids.includes(d))),
      );
      const page = matching.slice(-limit);
      return { ok: true, what: "record", entries: page.reverse().map((e) => shown(rules, e)), more: matching.length > limit };
    }
    case "rankings":
      return { ok: true, what: "rankings", domains: order.map((d) => summary(rules, order, d, t)) };
  }
}
