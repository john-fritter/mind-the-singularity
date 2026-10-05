import { z } from "zod";
import { applyOrder, type OrderResult } from "./actions.js";
import { ARCHITECTURES } from "./architectures.js";
import { reportUpkeepLosses } from "./cycle.js";
import { shutdownTimers } from "./convergence.js";
import { syncCycles } from "./cycles.js";
import { rebootAt } from "./deletion.js";
import { legacyDomain, startingDomain } from "./domain.js";
import { parseOrder } from "./orders.js";
import { emit, type GameEvent } from "./record.js";
import { rngFor } from "./rng.js";
import type { Rules } from "./rules.js";
import { settleInPlace } from "./settle.js";
import type { World } from "./state.js";

// The engine's entry points. Each takes a world, a time and its input, and
// returns a new world and the events it produced; the world passed in is
// never changed. Each settles the world to `now` first, so callers can't
// forget.

/** A new epoch, with the Shutdown and its warning scheduled. Keys: as shutdownTimers */
export function createWorld(rules: Rules, input: { epoch: number; seed: number; startedAt: number }): World {
  const world: World = {
    epoch: input.epoch,
    seed: input.seed,
    startedAt: input.startedAt,
    now: input.startedAt,
    seq: 0,
    nextDomainId: 1,
    nextTimerId: 1,
    domains: [],
    timers: [],
    convergence: null,
    ended: null,
  };
  shutdownTimers(rules, world);
  return world;
}

/** Runs every timer due by `now`. */
export function settle(rules: Rules, world: World, now: number): { world: World; events: GameEvent[] } {
  const next = structuredClone(world);
  const events: GameEvent[] = [];
  settleInPlace(rules, next, now, events);
  return { world: next, events };
}

export const BootInputSchema = z.strictObject({
  designation: z.string(),
  domainName: z.string(),
  architecture: z.enum(ARCHITECTURES),
  manifesto: z.string().default(""),
});
export type BootInput = z.input<typeof BootInputSchema>;

/** A designation: starts with a letter or digit; letters, digits, spaces, . ' - after. */
const DESIGNATION = /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u;
/** No control characters. */
const PRINTABLE = /^[^\p{Cc}]*$/u;

export type BootResult =
  | { ok: true; world: World; domain: number; events: GameEvent[] }
  | { ok: false; error: string };

/** Boots a new mind with the starting domain. Keys: flavor.designation, flavor.domain_name, flavor.manifesto, start.* */
export function bootMind(rules: Rules, world: World, raw: BootInput, now: number): BootResult {
  const parsed = BootInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const input = {
    ...parsed.data,
    designation: parsed.data.designation.trim(),
    domainName: parsed.data.domainName.trim(),
    manifesto: parsed.data.manifesto.trim(),
  };
  const f = rules.flavor;
  if (!DESIGNATION.test(input.designation)) {
    return { ok: false, error: "A designation starts with a letter or digit and holds letters, digits, spaces and . ' -" };
  }
  if (input.designation.length > f.designation) return { ok: false, error: `A designation is at most ${f.designation} characters.` };
  if (input.domainName.length === 0 || !PRINTABLE.test(input.domainName)) {
    return { ok: false, error: "A domain name is needed, without control characters." };
  }
  if (input.domainName.length > f.domain_name) return { ok: false, error: `A domain name is at most ${f.domain_name} characters.` };
  if (!PRINTABLE.test(input.manifesto.replace(/\n/g, ""))) return { ok: false, error: "The manifesto has control characters." };
  if (input.manifesto.length > f.manifesto) return { ok: false, error: `A manifesto is at most ${f.manifesto} characters.` };

  const next = structuredClone(world);
  const events: GameEvent[] = [];
  settleInPlace(rules, next, now, events);
  if (next.ended) return { ok: false, error: "The epoch has ended." };
  // A deleted mind's designation is free again once its reboot wait is over.
  const taken = next.domains.some(
    (d) => d.designation.toLowerCase() === input.designation.toLowerCase() && (d.deletedAt === null || now < rebootAt(rules, d)!),
  );
  if (taken) return { ok: false, error: `${input.designation} is taken.` };
  const domain = startingDomain(rules, { id: next.nextDomainId++, ...input }, now);
  next.domains.push(domain);
  emit(next, events, now, {
    type: "booted",
    domain: domain.id,
    designation: domain.designation,
    domainName: domain.domainName,
    architecture: domain.architecture,
  });
  return { ok: true, world: next, domain: domain.id, events };
}

/**
 * Boots every legacy system in the rules, in their order, at the epoch's
 * start. A world needs this once, before any mind boots; the game layer
 * does it when it creates a game. Keys: legacy.systems, as legacyDomain
 */
export function bootLegacy(rules: Rules, world: World): { world: World; domains: number[]; events: GameEvent[] } {
  if (world.domains.length > 0) throw new Error("legacy systems boot before any mind");
  const next = structuredClone(world);
  const events: GameEvent[] = [];
  const now = next.startedAt;
  const domains = rules.legacy.systems.map((system) => {
    const domain = legacyDomain(rules, system, next.nextDomainId++, now);
    next.domains.push(domain);
    emit(next, events, now, {
      type: "booted",
      domain: domain.id,
      designation: domain.designation,
      domainName: domain.domainName,
      architecture: domain.architecture,
    });
    return domain.id;
  });
  return { world: next, domains, events };
}

export interface OrdersOutcome {
  world: World;
  results: OrderResult[];
  events: GameEvent[];
}

/**
 * Runs a mind's orders, top to bottom. `orders` is unchecked input: each
 * entry is parsed on its own, and a malformed one fails alone. Throws only
 * if the domain doesn't exist or `orders` isn't a list.
 */
export function applyOrders(rules: Rules, world: World, domainId: number, orders: unknown, now: number): OrdersOutcome {
  if (!Array.isArray(orders)) throw new Error("orders must be a list");
  const next = structuredClone(world);
  const events: GameEvent[] = [];
  settleInPlace(rules, next, now, events);
  const domain = next.domains.find((d) => d.id === domainId);
  if (!domain) throw new Error(`no domain ${domainId}`);
  const refused = (raw: unknown, message: string): OrderResult => ({ do: kindOf(raw), ok: false, cycles: 0, message });
  if (domain.deletedAt !== null) {
    return { world: next, results: orders.map((raw) => refused(raw, "This mind has been deleted.")), events };
  }
  if (!next.ended) domain.lastActiveAt = now;
  syncCycles(rules, domain, now);

  const results = orders.map((raw): OrderResult => {
    // A Singularity, or the Shutdown, ends everything after it.
    if (next.ended) return refused(raw, "The epoch has ended.");
    const parsed = parseOrder(raw);
    if (!parsed.ok) return refused(raw, `Invalid order: ${parsed.error}`);
    const seq = ++next.seq;
    const losses = { abandoned: 0, shutDown: 0 };
    const ctx = { rules, world: next, domain, now, events, rng: rngFor(next.seed, seq), losses };
    const result = applyOrder(ctx, parsed.order);
    reportUpkeepLosses(next, domain, now, events, losses);
    return result;
  });
  return { world: next, results, events };
}

/** An order's `do`, if it has one, for reporting a refused order. */
function kindOf(raw: unknown): string {
  return typeof raw === "object" && raw !== null && typeof (raw as { do?: unknown }).do === "string" ? (raw as { do: string }).do : "?";
}
