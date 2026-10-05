import { z } from "zod";
import type { OrderResult } from "../engine/context.js";
import { availableCycles, HOUR_MS } from "../engine/cycles.js";
import { rebootAt } from "../engine/deletion.js";
import { domainPower } from "../engine/domain.js";
import type { Rules } from "../engine/rules.js";
import type { GameEvent } from "../engine/record.js";
import type { Domain, World } from "../engine/state.js";
import { applyOrders, bootLegacy, bootMind as engineBoot, createWorld, type BootInput } from "../engine/world.js";
import type { WorldStore } from "../store/store.js";
import { gameError, type Game, type GameError, type Identity, type Owner } from "./state.js";

// The one write path. Every change to a game goes through bootMind or
// submitOrders: each checks the caller, runs the engine under the store's
// lock, and logs what came in so the game can be rebuilt (replay.ts). Front
// ends parse their input, call these with the caller's identity, and
// render; they never check access or write themselves. Nothing here
// branches on what kind of player the caller is.

export const IdentitySchema = z.object({ account: z.string().trim().min(1).max(80) });

/** The account a legacy system orders from. No player account can be one: Phase 3's accounts never contain a colon. */
export const legacyAccount = (designation: string) => `legacy:${designation}`;

/**
 * An epoch's world as it starts: the Shutdown scheduled and the legacy
 * systems booted, each owned by its legacy account. replay.ts starts here too.
 */
export function startWorld(rules: Rules, start: Game["start"]): { world: World; owners: Owner[]; events: GameEvent[] } {
  const booted = bootLegacy(rules, createWorld(rules, start));
  const owners = booted.domains.map((id) => ({ account: legacyAccount(booted.world.domains.find((d) => d.id === id)!.designation), domain: id }));
  return { world: booted.world, owners, events: booted.events };
}

/** A new game: an epoch with only its legacy systems, playing by `rules` to its end. */
export function newGame(rules: Rules, start: { epoch: number; seed: number; startedAt: number }): Game {
  const { world, owners, events } = startWorld(rules, start);
  return { rules, start: { ...start }, world, owners, log: [], record: events };
}

/** The account's current mind, live or deleted, if it has booted one. */
export function currentMind(game: Game, account: string): Domain | undefined {
  const owner = game.owners.findLast((o) => o.account === account);
  return owner && game.world.domains.find((d) => d.id === owner.domain);
}

/** What submit_orders returns after the results: DESIGN.md's "short updated status". */
export interface ShortStatus {
  designation: string;
  cycles: number;
  territory: number;
  capital: number;
  compute: number;
  users: number;
  power: number;
}

export function shortStatus(rules: Rules, d: Domain, now: number): ShortStatus {
  return {
    designation: d.designation,
    cycles: availableCycles(rules, d, now),
    territory: d.territory,
    capital: d.capital,
    compute: d.compute,
    users: d.users,
    power: domainPower(rules, d),
  };
}

function checkIdentity(identity: Identity): GameError | undefined {
  const parsed = IdentitySchema.safeParse(identity);
  return parsed.success ? undefined : gameError("invalid", "An account name is needed, at most 80 characters.");
}

function checkTime(world: World, now: number): GameError | undefined {
  if (!Number.isFinite(now)) return gameError("invalid", "The time isn't a number.");
  if (now < world.now) return gameError("invalid", "That time is before the game's own clock; it never runs backward.");
  return undefined;
}

export type BootOutcome = { ok: true; designation: string; status: ShortStatus } | GameError;

/**
 * Boots a mind for an account. An account has one live mind at a time; once
 * it's deleted, the same account may boot again after the reboot wait.
 * `input` is unchecked: the engine parses it.
 */
export function bootMind(store: WorldStore, identity: Identity, input: unknown, now: number): Promise<BootOutcome> {
  const bad = checkIdentity(identity);
  if (bad) return Promise.resolve(bad);
  const account = identity.account.trim();
  return store.update<BootOutcome>((game) => {
    const refuse = (e: GameError) => ({ write: null, value: e });
    const late = checkTime(game.world, now);
    if (late) return refuse(late);
    const mind = currentMind(game, account);
    if (mind && mind.deletedAt === null) return refuse(gameError("refused", `You already run ${mind.designation}.`));
    if (mind && now < rebootAt(game.rules, mind)!) {
      const hours = Math.ceil((rebootAt(game.rules, mind)! - now) / HOUR_MS);
      return refuse(gameError("refused", `${mind.designation} was deleted; you may boot again in ${hours}h.`));
    }
    const booted = engineBoot(game.rules, game.world, input as BootInput, now);
    if (!booted.ok) return refuse(gameError("invalid", booted.error));
    const domain = booted.world.domains.find((d) => d.id === booted.domain)!;
    return {
      write: {
        world: booted.world,
        events: booted.events,
        entry: { kind: "boot", at: now, account, seq: booted.world.seq, input: structuredClone(input), domain: booted.domain },
        owner: { account, domain: booted.domain },
      },
      value: { ok: true, designation: domain.designation, status: shortStatus(game.rules, domain, now) },
    };
  });
}

export type OrdersOutcome = { ok: true; results: OrderResult[]; status: ShortStatus } | GameError;

/**
 * Runs the account's mind's orders, top to bottom. `orders` is unchecked
 * input: it must be a list, and each entry is parsed on its own by the
 * engine, so a malformed order fails alone.
 */
export function submitOrders(store: WorldStore, identity: Identity, orders: unknown, now: number): Promise<OrdersOutcome> {
  const bad = checkIdentity(identity);
  if (bad) return Promise.resolve(bad);
  if (!Array.isArray(orders)) return Promise.resolve(gameError("invalid", "Orders are a JSON list."));
  const account = identity.account.trim();
  return store.update<OrdersOutcome>((game) => {
    const refuse = (e: GameError) => ({ write: null, value: e });
    const late = checkTime(game.world, now);
    if (late) return refuse(late);
    const mind = currentMind(game, account);
    if (!mind) return refuse(gameError("not_found", "You have no mind; boot one first."));
    const out = applyOrders(game.rules, game.world, mind.id, orders, now);
    const after = out.world.domains.find((d) => d.id === mind.id)!;
    return {
      write: {
        world: out.world,
        events: out.events,
        entry: { kind: "orders", at: now, account, seq: out.world.seq, domain: mind.id, orders: structuredClone(orders), results: out.results },
      },
      value: { ok: true, results: out.results, status: shortStatus(game.rules, after, now) },
    };
  });
}
