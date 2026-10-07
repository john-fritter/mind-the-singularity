import { z } from "zod";
import { loadSite } from "../config.js";
import type { OrderResult } from "../engine/context.js";
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
import { gameError, type GameError, type Identity } from "./state.js";

// The admin view (DESIGN.md: "An admin view for John can show
// everything"): every mind's full status and scratchpad, every channel,
// the whole Record and the orders log, of any epoch. Only an identity
// with the admin flag, which only a web login carries, gets anything; to
// anyone else every one of these is "not found", the same as what doesn't
// exist, before any epoch is opened. Read only: nothing here writes, and
// nothing outside this file reads the flag.

/** The pages' common top: which epoch, and the others there are to look at. */
export interface AdminEpoch {
  epoch: EpochStatus;
  /** Every epoch's number, newest first. */
  epochs: number[];
  /** Whether this is the newest epoch, whose pages need no `epoch` in their links. */
  newest: boolean;
  /** Display names by id, for full status. */
  names: Record<string, string>;
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
}

/** An event of the Record, private ones included, with its full text. */
export interface AdminEntry {
  seq: number;
  at: number;
  type: EventType;
  public: boolean;
  text: string;
  minds: MindRef[];
}

/** A message on any channel. */
export interface AdminMessage {
  seq: number;
  at: number;
  from: MindRef;
  to: MindRef;
  text: string;
}

/** A write in the orders log: a boot, or one call's orders each with the engine's result. */
export interface AdminLogEntry {
  /** Its place in the log, from 1; `before` pages back by it. */
  index: number;
  at: number;
  account: string;
  kind: "boot" | "orders";
  mind: MindRef;
  /** The boot's input, as JSON. */
  input: string | null;
  orders: { order: string; result: OrderResult | null }[];
}

export interface AdminOverview extends AdminEpoch {
  /** Live minds by rank, then deleted ones, newest deletion first. */
  minds: AdminMindRow[];
}

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
  messages: { entries: AdminMessage[]; more: boolean };
  /** Every event about it, private ones included, newest first. */
  record: { entries: AdminEntry[]; more: boolean };
}

export interface AdminListPage<T> extends AdminEpoch {
  entries: T[];
  more: boolean;
}

const notFound = () => gameError("not_found", "There's nothing here.");
const before = z.coerce.number().int().positive().optional();
const epochKey = z.coerce.number().int().positive().optional();
const name = z.string().trim().min(1).max(80).optional();

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
  return {
    r,
    top: {
      epoch: status(r),
      epochs: numbers,
      newest: number === numbers[0],
      names: names(r.rules),
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

function row(r: Read, d: Domain): AdminMindRow {
  return {
    mind: mindRef(r.world, d.id),
    owner: r.game.owners.find((o) => o.domain === d.id)?.account ?? "?",
    legacy: d.legacy,
    summary: summary(r.rules, r.order, d, r.now),
    status: domainStatus(r.rules, d, r.now),
    deletedAt: d.deletedAt,
    scratchpadChars: d.scratchpad.length,
  };
}

const entry = (r: Read, e: GameEvent): AdminEntry => ({
  seq: e.seq,
  at: e.at,
  type: e.type,
  public: e.public,
  text: describe(r.rules, e),
  minds: e.domains.map((id) => mindRef(r.world, id)),
});

const isMessage = (e: GameEvent): e is GameEvent & { type: "message" } => e.type === "message";

const message = (r: Read, e: GameEvent & { type: "message" }): AdminMessage => ({
  seq: e.seq,
  at: e.at,
  from: mindRef(r.world, e.from),
  to: mindRef(r.world, e.to),
  text: e.text,
});

/** The newest items matching `keep`, `limit` at most, newest first; `more` when older ones match. */
function tail<A, B>(items: readonly A[], keep: (a: A) => boolean, limit: number, map: (a: A) => B): { entries: B[]; more: boolean } {
  const out: B[] = [];
  let i = items.length - 1;
  for (; i >= 0 && out.length < limit; i--) if (keep(items[i]!)) out.push(map(items[i]!));
  for (; i >= 0; i--) if (keep(items[i]!)) return { entries: out, more: true };
  return { entries: out, more: false };
}

/** Domain ids by designation (and number), or not found. */
function idsNamed(r: Read, mind: string, n: number | undefined): number[] | GameError {
  const named = domainsNamed(r.world, mind);
  const ids = (n === undefined ? named : named.filter((d) => d.id === n)).map((d) => d.id);
  return ids.length === 0 ? gameError("not_found", `No mind called ${mind}.`) : ids;
}

/** Every mind in an epoch with its full status and its owner. */
export async function adminOverview(epochs: Epochs, identity: Identity, query: unknown, now: number): Promise<AdminOverview | GameError> {
  const got = await admit(epochs, identity, z.strictObject({ epoch: epochKey }), query, now);
  if ("ok" in got) return got;
  const { r } = got;
  const gone = r.world.domains.filter((d) => d.deletedAt !== null).sort((a, b) => b.deletedAt! - a.deletedAt! || b.id - a.id);
  return { ...got.top, minds: [...r.order, ...gone].map((d) => row(r, d)) };
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
  const limit = loadSite().web.page;
  const target = d.researchTarget;
  const protocol = protocolOf(r.world, d.id);
  return {
    ...got.top,
    row: row(r, d),
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
    messages: tail(
      r.record,
      (e) => isMessage(e) && (e.from === d.id || e.to === d.id),
      limit,
      (e) => message(r, e as GameEvent & { type: "message" }),
    ),
    record: tail(
      r.record,
      (e) => !isMessage(e) && e.domains.includes(d.id) && (q.before === undefined || e.seq < q.before),
      limit,
      (e) => entry(r, e),
    ),
  };
}

/** Every message on every channel, newest first, or one mind's. */
export async function adminChannels(
  epochs: Epochs,
  identity: Identity,
  query: unknown,
  now: number,
): Promise<AdminListPage<AdminMessage> | GameError> {
  const got = await admit(epochs, identity, z.strictObject({ epoch: epochKey, mind: name, before }), query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const ids = q.mind === undefined ? undefined : idsNamed(r, q.mind, undefined);
  if (ids !== undefined && "ok" in ids) return ids;
  const keep = (e: GameEvent) =>
    isMessage(e) && (q.before === undefined || e.seq < q.before) && (ids === undefined || ids.includes(e.from) || ids.includes(e.to));
  return {
    ...got.top,
    ...tail(r.record, keep, loadSite().web.page, (e) => message(r, e as GameEvent & { type: "message" })),
  };
}

/** The whole Record, private events and posts included, newest first, filtered by mind and type. */
export async function adminRecord(
  epochs: Epochs,
  identity: Identity,
  query: unknown,
  now: number,
): Promise<AdminListPage<AdminEntry> | GameError> {
  const schema = z.strictObject({
    epoch: epochKey,
    mind: name,
    n: z.coerce.number().int().positive().optional(),
    type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]).optional(),
    before,
  });
  const got = await admit(epochs, identity, schema, query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const ids = q.mind === undefined ? undefined : idsNamed(r, q.mind, q.n);
  if (ids !== undefined && "ok" in ids) return ids;
  const keep = (e: GameEvent) =>
    (q.type === undefined || e.type === q.type) &&
    (q.before === undefined || e.seq < q.before) &&
    (ids === undefined || e.domains.some((id) => ids.includes(id)));
  return {
    ...got.top,
    ...tail(r.record, keep, loadSite().web.page, (e) => entry(r, e)),
  };
}

/** The orders log, newest first, filtered by account or mind: every boot and orders call as it came in, with the engine's results. */
export async function adminOrders(
  epochs: Epochs,
  identity: Identity,
  query: unknown,
  now: number,
): Promise<AdminListPage<AdminLogEntry> | GameError> {
  const got = await admit(epochs, identity, z.strictObject({ epoch: epochKey, account: name, mind: name, before }), query, now);
  if ("ok" in got) return got;
  const { r, q } = got;
  const ids = q.mind === undefined ? undefined : idsNamed(r, q.mind, undefined);
  if (ids !== undefined && "ok" in ids) return ids;
  const account = q.account?.toLowerCase();
  const indexed = r.game.log.map((e, i) => ({ e, index: i + 1 }));
  const keep = ({ e, index }: (typeof indexed)[number]) =>
    (q.before === undefined || index < q.before) &&
    (account === undefined || e.account.toLowerCase() === account) &&
    (ids === undefined || ids.includes(e.domain));
  const page = tail(
    indexed,
    keep,
    loadSite().web.page,
    ({ e, index }): AdminLogEntry => ({
      index,
      at: e.at,
      account: e.account,
      kind: e.kind,
      mind: mindRef(r.world, e.domain),
      input: e.kind === "boot" ? JSON.stringify(e.input) : null,
      orders:
        e.kind === "orders"
          ? e.orders.map((order, i) => ({
              order: JSON.stringify(order),
              result: e.results[i] ?? null,
            }))
          : [],
    }),
  );
  return { ...got.top, ...page };
}
