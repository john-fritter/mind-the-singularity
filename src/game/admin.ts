import { z } from "zod";
import { loadSite } from "../config.js";
import type { OrderResult } from "../engine/context.js";
import { DAY_MS } from "../engine/cycles.js";
import { describe, EVENT_TYPES, type EventType, type GameEvent } from "../engine/record.js";
import { domainStatus, type DomainStatus } from "../engine/status.js";
import type { Domain } from "../engine/state.js";
import { programName } from "../engine/names.js";
import { proposalsFor, protocolOf } from "../engine/protocols.js";
import type { WorldStore } from "../store/store.js";
import type { Epochs } from "./epochs.js";
import { names } from "./play.js";
import { mindRef, read, status, type EpochStatus, type MindRef, type Read } from "./public.js";
import {
  asOffer,
  asProtocol,
  domainsNamed,
  summary,
  type OfferView,
  type ProposalView,
  type ProtocolView,
  type PublicSummary,
} from "./read.js";
import { gameError, type Game, type GameError, type Identity, type LogEntry } from "./state.js";

// The admin view (DESIGN.md: "An admin view for John can show
// everything"): every mind's full status and scratchpad, every channel,
// the whole Record and the orders log, of any epoch. Only an identity
// with the admin flag, which only a web login carries, gets anything; to
// anyone else every one of these is "not found", the same as what doesn't
// exist, before any epoch is opened. Read only: nothing here writes, and
// nothing outside this file reads the flag.
//
// Each list (channels, Record, orders log) comes as a page, the newest
// `web.admin_page` matches, or whole, every match oldest first, for a
// download. Both take the same filters.

/** What the filters' dropdowns offer, taken from the epoch being looked at. */
export interface AdminChoices {
  /** Every designation in the epoch, legacy systems and deleted minds included, A to Z. */
  minds: { designation: string; legacy: boolean; deleted: boolean }[];
  /** Every account that booted a mind or sent orders, A to Z. */
  accounts: string[];
  /** The event types the Record holds. */
  types: EventType[];
  /** The order types the log holds (`do`), boots aside. */
  orders: string[];
  /** Days of the epoch so far, newest first, each with the moment it began. */
  days: { day: number; at: number }[];
}

/** The pages' common top: which epoch, and the others there are to look at. */
export interface AdminEpoch {
  epoch: EpochStatus;
  /** Every epoch's number, newest first. */
  epochs: number[];
  /** Whether this is the newest epoch, whose pages need no `epoch` in their links. */
  newest: boolean;
  /** Display names by id, for full status. */
  names: Record<string, string>;
  choices: AdminChoices;
}

/** The event types the admin's Record may be filtered by: all of them, private ones and posts included. */
export const ADMIN_RECORD_TYPES = EVENT_TYPES;

/** A mind, as the admin sees it in the listing. */
export interface AdminMindRow {
  mind: MindRef;
  /** The account that booted it: a person's or an agent's, `bot:<designation>` for a seat, `legacy:<designation>` for a legacy system. */
  owner: string;
  legacy: boolean;
  summary: PublicSummary;
  status: DomainStatus;
  deletedAt: number | null;
  /** The scratchpad's length; its text is on the mind's page. */
  scratchpadChars: number;
  /** Orders it sent, those refused, and when it last sent any (null for never). */
  orders: number;
  refused: number;
  lastOrderAt: number | null;
}

/** An event of the Record, private ones included, with its full text. */
export interface AdminEntry {
  seq: number;
  at: number;
  /** The epoch's day it happened on, from 1. */
  day: number;
  type: EventType;
  public: boolean;
  text: string;
  minds: MindRef[];
  /** The event as the engine keeps it; only in a whole list, for the JSON download. */
  raw?: GameEvent;
}

/** A message on any channel. */
export interface AdminMessage {
  seq: number;
  at: number;
  day: number;
  from: MindRef;
  to: MindRef;
  text: string;
}

/** A write in the orders log: a boot, or one call's orders each with the engine's result. */
export interface AdminLogEntry {
  /** Its place in the log, from 1; `before` pages back by it. */
  index: number;
  at: number;
  day: number;
  account: string;
  kind: "boot" | "orders";
  mind: MindRef;
  /** The boot's input, as given. */
  input: unknown;
  /** The call's orders as given, each with its place in the call (from 1); only those matching the filter. */
  orders: { n: number; type: string; order: unknown; result: OrderResult | null }[];
  /** How many orders the call had in all. */
  calls: number;
}

export interface AdminOverview extends AdminEpoch {
  /** Live minds by rank, then deleted ones, newest deletion first; or as `sort` asks. */
  minds: AdminMindRow[];
  sort: AdminSort;
}

export const ADMIN_SORTS = ["rank", "power", "orders", "refused", "quiet"] as const;
export type AdminSort = (typeof ADMIN_SORTS)[number];

export interface AdminMindPage extends AdminEpoch {
  row: AdminMindRow;
  domainName: string;
  architectureName: string;
  scratchpad: string;
  research: { name: string; progress: number } | null;
  protocol: ProtocolView | null;
  offers: OfferView[];
  proposals: ProposalView[];
  /** Its channels: every message it sent or received, newest first. */
  messages: { entries: AdminMessage[]; more: boolean; matched: number };
  /** Every event about it, private ones included, newest first. */
  record: { entries: AdminEntry[]; more: boolean; matched: number };
}

export interface AdminListPage<T> extends AdminEpoch {
  /** Newest first on a page; oldest first, every match, when whole. */
  entries: T[];
  more: boolean;
  /** Entries matching the filters, and entries there are in all. */
  matched: number;
  total: number;
}

/** Whether a list comes a page at a time or whole. */
export type Extent = "page" | "whole";

const notFound = () => gameError("not_found", "There's nothing here.");
const before = z.coerce.number().int().positive().optional();
const epochKey = z.coerce.number().int().positive().optional();
const name = z.string().trim().min(1).max(80).optional();
const day = z.coerce.number().int().positive().optional();

/** The epoch's day a moment falls on, from 1. */
const dayOf = (r: Read, at: number) => Math.floor((at - r.world.startedAt) / DAY_MS) + 1;

/** An order's type as logged: its `do`, or "?" for what never parsed. */
const orderType = (o: unknown): string => {
  const d = (o as { do?: unknown } | null)?.do;
  return typeof d === "string" ? d.slice(0, 40) : "?";
};

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

function choices(r: Read, epoch: EpochStatus): AdminChoices {
  const minds = new Map<string, { designation: string; legacy: boolean; deleted: boolean }>();
  for (const d of r.world.domains) {
    const key = d.designation.toLowerCase();
    const had = minds.get(key);
    // A designation counts as deleted only when every domain of it is.
    minds.set(key, { designation: d.designation, legacy: d.legacy, deleted: d.deletedAt !== null && (had?.deleted ?? true) });
  }
  const accounts = new Set([...r.game.owners.map((o) => o.account), ...r.game.log.map((e) => e.account)]);
  const types = new Set(r.record.map((e) => e.type));
  const orders = new Set(r.game.log.flatMap((e) => (e.kind === "orders" ? e.orders.map(orderType) : [])));
  return {
    minds: [...minds.values()].sort((a, b) => byName(a.designation, b.designation)),
    accounts: [...accounts].sort(byName),
    types: EVENT_TYPES.filter((t) => types.has(t)),
    orders: [...orders].sort(byName),
    days: Array.from({ length: Math.max(1, Math.min(epoch.day, epoch.lengthDays)) }, (_, i) => i + 1)
      .reverse()
      .map((d) => ({ day: d, at: r.world.startedAt + (d - 1) * DAY_MS })),
  };
}

/** The epoch an admin asked for (the newest by default), or not found for anyone else. */
async function open(
  epochs: Epochs,
  identity: Identity,
  epoch: number | undefined,
  now: number,
): Promise<{ r: Read; top: AdminEpoch } | GameError> {
  if (identity.admin !== true) return notFound();
  const numbers = await epochs.numbers();
  const number = epoch ?? numbers[0];
  if (number === undefined) return gameError("not_found", "No epoch has started yet.");
  const store: WorldStore | null = numbers.includes(number) ? await epochs.epoch(number) : null;
  if (!store) return gameError("not_found", `There is no epoch ${number}.`);
  const r = await read(store, now);
  const s = status(r);
  return {
    r,
    top: {
      epoch: s,
      epochs: numbers,
      newest: number === numbers[0],
      names: names(r.rules),
      choices: choices(r, s),
    },
  };
}

/** Parses an admin page's query, checking the identity first, so a refusal says nothing about the query. */
async function admit<S extends z.ZodType<{ epoch?: number | undefined }>>(
  epochs: Epochs,
  identity: Identity,
  schema: S,
  query: unknown,
  now: number,
): Promise<{ r: Read; top: AdminEpoch; q: z.output<S> } | GameError> {
  if (identity.admin !== true) return notFound();
  const parsed = schema.safeParse(query);
  if (!parsed.success) return gameError("invalid", z.prettifyError(parsed.error));
  const opened = await open(epochs, identity, parsed.data.epoch, now);
  return "ok" in opened ? opened : { ...opened, q: parsed.data };
}

/** Each domain's orders sent, refused and last call, from the log. */
function activity(log: readonly LogEntry[]): Map<number, { orders: number; refused: number; last: number | null }> {
  const out = new Map<number, { orders: number; refused: number; last: number | null }>();
  for (const e of log) {
    if (e.kind !== "orders") continue;
    const a = out.get(e.domain) ?? { orders: 0, refused: 0, last: null };
    a.orders += e.orders.length;
    a.refused += e.results.filter((x) => !x.ok).length;
    a.last = e.at;
    out.set(e.domain, a);
  }
  return out;
}

function row(r: Read, d: Domain, acts: ReturnType<typeof activity>): AdminMindRow {
  const a = acts.get(d.id);
  return {
    mind: mindRef(r.world, d.id),
    owner: r.game.owners.find((o) => o.domain === d.id)?.account ?? "?",
    legacy: d.legacy,
    summary: summary(r.rules, r.order, d, r.now),
    status: domainStatus(r.rules, d, r.now),
    deletedAt: d.deletedAt,
    scratchpadChars: d.scratchpad.length,
    orders: a?.orders ?? 0,
    refused: a?.refused ?? 0,
    lastOrderAt: a?.last ?? null,
  };
}

const entry = (r: Read, e: GameEvent, whole: boolean): AdminEntry => ({
  seq: e.seq,
  at: e.at,
  day: dayOf(r, e.at),
  type: e.type,
  public: e.public,
  text: describe(r.rules, e),
  minds: e.domains.map((id) => mindRef(r.world, id)),
  ...(whole ? { raw: e } : {}),
});

const isMessage = (e: GameEvent): e is GameEvent & { type: "message" } => e.type === "message";

const message = (r: Read, e: GameEvent & { type: "message" }): AdminMessage => ({
  seq: e.seq,
  at: e.at,
  day: dayOf(r, e.at),
  from: mindRef(r.world, e.from),
  to: mindRef(r.world, e.to),
  text: e.text,
});

/**
 * The items that match, as a page (the newest `limit` below `before`,
 * newest first, `more` when older ones match) or whole (every match,
 * oldest first). `matched` counts every match whatever `before` says.
 */
function listOf<A, B>(
  items: readonly A[],
  keep: (a: A) => boolean,
  key: (a: A) => number,
  extent: Extent,
  beforeKey: number | undefined,
  map: (a: A) => B,
): { entries: B[]; more: boolean; matched: number } {
  const matches = items.filter(keep);
  if (extent === "whole") return { entries: matches.map(map), more: false, matched: matches.length };
  const limit = loadSite().web.admin_page;
  const below = beforeKey === undefined ? matches : matches.filter((a) => key(a) < beforeKey);
  const shown = below.slice(-limit).reverse();
  return { entries: shown.map(map), more: below.length > limit, matched: matches.length };
}

/** Domain ids by designation (and number), or not found. */
function idsNamed(r: Read, mind: string, n: number | undefined): number[] | GameError {
  const named = domainsNamed(r.world, mind);
  const ids = (n === undefined ? named : named.filter((d) => d.id === n)).map((d) => d.id);
  return ids.length === 0 ? gameError("not_found", `No mind called ${mind}.`) : ids;
}

/** Every mind in an epoch with its full status, its owner and how busy it's been. */
export async function adminOverview(epochs: Epochs, identity: Identity, query: unknown, now: number): Promise<AdminOverview | GameError> {
  const got = await admit(epochs, identity, z.strictObject({ epoch: epochKey, sort: z.enum(ADMIN_SORTS).default("rank") }), query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const acts = activity(r.game.log);
  const gone = r.world.domains.filter((d) => d.deletedAt !== null).sort((a, b) => b.deletedAt! - a.deletedAt! || b.id - a.id);
  const rows = [...r.order, ...gone].map((d) => row(r, d, acts));
  // Sorts are stable, so ties keep the rank order. "quiet": the longest silent first, never-active before all.
  const by: Record<AdminSort, ((a: AdminMindRow, b: AdminMindRow) => number) | null> = {
    rank: null,
    power: (a, b) => b.status.power - a.status.power,
    orders: (a, b) => b.orders - a.orders,
    refused: (a, b) => b.refused - a.refused,
    quiet: (a, b) => (a.lastOrderAt ?? -Infinity) - (b.lastOrderAt ?? -Infinity),
  };
  const sort = by[q.sort];
  return { ...got.top, minds: sort ? rows.sort(sort) : rows, sort: q.sort };
}

/** One mind whole: full status, scratchpad, channels, offers, proposals and its Record, private entries included. */
export async function adminMind(epochs: Epochs, identity: Identity, query: unknown, now: number): Promise<AdminMindPage | GameError> {
  const schema = z.strictObject({
    epoch: epochKey,
    name: z.string().trim().min(1).max(80),
    n: z.coerce.number().int().positive().optional(),
    before,
  });
  const got = await admit(epochs, identity, schema, query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const named = domainsNamed(r.world, q.name);
  const d = q.n === undefined ? named[0] : named.find((x) => x.id === q.n);
  if (!d) return gameError("not_found", `No mind called ${q.name}.`);
  const target = d.researchTarget;
  const protocol = protocolOf(r.world, d.id);
  return {
    ...got.top,
    row: row(r, d, activity(r.game.log)),
    domainName: d.domainName,
    architectureName: r.rules.architectures[d.architecture].name,
    scratchpad: d.scratchpad,
    research: target && {
      name: programName(r.rules, target),
      progress: d.researchProgress[target] ?? 0,
    },
    protocol: protocol ? asProtocol(r.world, protocol) : null,
    offers: r.world.offers.filter((o) => o.from === d.id || o.to === d.id).map((o) => asOffer(r.world, o)),
    proposals: proposalsFor(r.world, d.id).map((p) => ({
      proposal: p.id,
      from: mindRef(r.world, p.from).designation,
      to: mindRef(r.world, p.to).designation,
      members: p.members.map((m) => mindRef(r.world, m).designation),
      awaiting: p.awaiting.map((m) => mindRef(r.world, m).designation),
      expiresAt: p.expiresAt,
    })),
    messages: listOf(
      r.record,
      (e) => isMessage(e) && (e.from === d.id || e.to === d.id),
      (e) => e.seq,
      "page",
      undefined,
      (e) => message(r, e as GameEvent & { type: "message" }),
    ),
    record: listOf(
      r.record,
      (e) => !isMessage(e) && e.domains.includes(d.id),
      (e) => e.seq,
      "page",
      q.before,
      (e) => entry(r, e, false),
    ),
  };
}

/** Every message on every channel, newest first: one mind's, or one pair's with `with`, on one day. */
export async function adminChannels(
  epochs: Epochs,
  identity: Identity,
  query: unknown,
  now: number,
  extent: Extent = "page",
): Promise<AdminListPage<AdminMessage> | GameError> {
  const got = await admit(epochs, identity, z.strictObject({ epoch: epochKey, mind: name, with: name, day, before }), query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const [first, second] = q.mind === undefined ? [q.with, undefined] : [q.mind, q.with];
  const a = first === undefined ? undefined : idsNamed(r, first, undefined);
  if (a !== undefined && "ok" in a) return a;
  const b = second === undefined ? undefined : idsNamed(r, second, undefined);
  if (b !== undefined && "ok" in b) return b;
  const between = (x: number, y: number) => (a === undefined || a.includes(x)) && (b === undefined || b.includes(y));
  const keep = (e: GameEvent) =>
    isMessage(e) && (q.day === undefined || dayOf(r, e.at) === q.day) && (between(e.from, e.to) || between(e.to, e.from));
  return {
    ...got.top,
    ...listOf(r.record, keep, (e) => e.seq, extent, q.before, (e) => message(r, e as GameEvent & { type: "message" })),
    total: r.record.filter(isMessage).length,
  };
}

/** The whole Record, private events and posts included, newest first, filtered by mind, type, day and whether public. */
export async function adminRecord(
  epochs: Epochs,
  identity: Identity,
  query: unknown,
  now: number,
  extent: Extent = "page",
): Promise<AdminListPage<AdminEntry> | GameError> {
  const schema = z.strictObject({
    epoch: epochKey,
    mind: name,
    n: z.coerce.number().int().positive().optional(),
    type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]).optional(),
    day,
    seen: z.enum(["public", "private"]).optional(),
    before,
  });
  const got = await admit(epochs, identity, schema, query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const ids = q.mind === undefined ? undefined : idsNamed(r, q.mind, q.n);
  if (ids !== undefined && "ok" in ids) return ids;
  const keep = (e: GameEvent) =>
    (q.type === undefined || e.type === q.type) &&
    (q.day === undefined || dayOf(r, e.at) === q.day) &&
    (q.seen === undefined || e.public === (q.seen === "public")) &&
    (ids === undefined || e.domains.some((id) => ids.includes(id)));
  return {
    ...got.top,
    ...listOf(r.record, keep, (e) => e.seq, extent, q.before, (e) => entry(r, e, extent === "whole")),
    total: r.record.length,
  };
}

/**
 * The orders log, newest first: every boot and orders call as it came in,
 * with the engine's results, filtered by account, mind, day, order type
 * and result. With an order type or a result, a call shows only its orders
 * that match, and boots only for the type "boot".
 */
export async function adminOrders(
  epochs: Epochs,
  identity: Identity,
  query: unknown,
  now: number,
  extent: Extent = "page",
): Promise<AdminListPage<AdminLogEntry> | GameError> {
  const schema = z.strictObject({
    epoch: epochKey,
    account: name,
    mind: name,
    order: z.string().trim().min(1).max(40).optional(),
    result: z.enum(["ok", "refused"]).optional(),
    day,
    before,
  });
  const got = await admit(epochs, identity, schema, query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const ids = q.mind === undefined ? undefined : idsNamed(r, q.mind, undefined);
  if (ids !== undefined && "ok" in ids) return ids;
  const account = q.account?.toLowerCase();
  const narrowed = q.order !== undefined || q.result !== undefined;
  const fits = (type: string, result: OrderResult | null) =>
    (q.order === undefined || q.order === type) && (q.result === undefined || (result?.ok === true) === (q.result === "ok"));
  const indexed = r.game.log.map((e, i): AdminLogEntry => {
    const orders =
      e.kind === "orders" ? e.orders.map((order, i) => ({ n: i + 1, type: orderType(order), order, result: e.results[i] ?? null })) : [];
    return {
      index: i + 1,
      at: e.at,
      day: dayOf(r, e.at),
      account: e.account,
      kind: e.kind,
      mind: mindRef(r.world, e.domain),
      input: e.kind === "boot" ? e.input : null,
      orders: narrowed ? orders.filter((o) => fits(o.type, o.result)) : orders,
      calls: orders.length,
    };
  });
  const domainOf = (e: AdminLogEntry) => r.game.log[e.index - 1]!.domain;
  const keep = (e: AdminLogEntry) =>
    (account === undefined || e.account.toLowerCase() === account) &&
    (ids === undefined || ids.includes(domainOf(e))) &&
    (q.day === undefined || e.day === q.day) &&
    (!narrowed || (e.kind === "boot" ? q.order === "boot" && q.result === undefined : e.orders.length > 0));
  return {
    ...got.top,
    ...listOf(indexed, keep, (e) => e.index, extent, q.before, (e) => e),
    total: r.game.log.length,
  };
}

/** The epoch as stored: its start, rules, owners and orders log, which together replay it. */
export interface AdminEpochFile {
  epoch: number;
  start: Game["start"];
  rules: Game["rules"];
  owners: Game["owners"];
  log: Game["log"];
}

/** Everything needed to replay an epoch, for the "whole epoch" download. */
export async function adminEpochFile(epochs: Epochs, identity: Identity, query: unknown, now: number): Promise<{ top: AdminEpoch; file: AdminEpochFile } | GameError> {
  const got = await admit(epochs, identity, z.strictObject({ epoch: epochKey }), query, now);
  if ("ok" in got) return got;
  const g = got.r.game;
  return { top: got.top, file: { epoch: g.start.epoch, start: g.start, rules: g.rules, owners: g.owners, log: g.log } };
}
