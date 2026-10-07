import { z } from "zod";
import { loadSite } from "../config.js";
import { domainPower } from "../engine/domain.js";
import { PUBLIC_EVENT_TYPES, type EventType, type GameEvent } from "../engine/record.js";
import type { Rules } from "../engine/rules.js";
import type { Architecture } from "../engine/architectures.js";
import type { Domain, World } from "../engine/state.js";
import { protocolOf } from "../engine/protocols.js";
import type { WorldStore } from "../store/store.js";
import type { Epochs } from "./epochs.js";
import {
  asOffer,
  convergenceOf,
  domainsNamed,
  epochOf,
  isPost,
  asPost,
  newestPosts,
  publicPage,
  ranked,
  settledAt,
  shown,
  SOCIAL,
  summary,
  type Brief,
  type OfferView,
  type Post,
  type PublicPage,
  type PublicSummary,
} from "./read.js";
import { gameError, type Game, type GameError } from "./state.js";

// What anyone may read, signed in or not: the public web view's pages.
// Each page settles a copy of the world once and saves nothing, as `view`
// does. Nothing here takes an identity, so nothing here can show what only
// one mind may see: no channels, no scratchpads, no full status, no offers
// made to one mind, no protocol proposals. The Record is its public events
// only, posts aside (the Commons shows them).

/**
 * A link to a mind: its designation, and its domain number when another
 * domain in the epoch had the same designation (a mind rebooted after its
 * deletion), so the link finds the right one.
 */
export interface MindRef {
  designation: string;
  n: number | null;
}

/** A public Record entry, with the minds it's about. */
export interface RecordEntry {
  seq: number;
  at: number;
  type: EventType;
  text: string;
  minds: MindRef[];
}

/** The epoch, as the top of every page shows it. */
export interface EpochStatus {
  number: number;
  /** Day of the epoch, from 1. */
  day: number;
  lengthDays: number;
  startedAt: number;
  shutdownAt: number;
  /** The Shutdown has been announced (its final week) and the epoch hasn't ended. */
  warned: boolean;
  ended: Brief["epoch"]["ended"];
  convergence: Brief["convergence"];
}

/** A line of the rankings. */
export interface RankRow extends PublicSummary {
  mind: MindRef;
  architectureName: string;
  domainName: string;
  /** A code-run legacy system, not a mind. */
  legacy: boolean;
  /** Its protocol partners. */
  protocol: MindRef[];
}

/** The event types the public Record may be filtered by: everything public but Commons posts. */
export const RECORD_TYPES: readonly EventType[] = PUBLIC_EVENT_TYPES.filter((t) => !SOCIAL.has(t));

const before = z.coerce.number().int().positive().optional();

export const RecordFilterSchema = z.strictObject({
  /** Only events about minds of this designation. */
  mind: z.string().trim().min(1).max(80).optional(),
  /** Only events about this one domain (with `mind`, its designation). */
  n: z.coerce.number().int().positive().optional(),
  type: z.enum(RECORD_TYPES as [EventType, ...EventType[]]).optional(),
  /** Only events before this sequence number, to page back. */
  before,
});
export type RecordFilter = z.input<typeof RecordFilterSchema>;

/** A game settled to now, with what every page needs. The admin view (admin.ts) reads through it too. */
export interface Read {
  game: Game;
  rules: Rules;
  world: World;
  record: GameEvent[];
  now: number;
  order: Domain[];
}

export async function read(store: WorldStore, now: number): Promise<Read> {
  const game = await store.read();
  const { world, record, now: t } = settledAt(game, now);
  return { game, rules: game.rules, world, record, now: t, order: ranked(game.rules, world) };
}

export function mindRef(world: World, id: number): MindRef {
  const d = world.domains.find((x) => x.id === id);
  if (!d) return { designation: "?", n: null };
  const key = d.designation.toLowerCase();
  const shared = world.domains.some((x) => x !== d && x.designation.toLowerCase() === key);
  return { designation: d.designation, n: shared ? d.id : null };
}

function entry(r: Read, e: GameEvent): RecordEntry {
  const { text } = shown(r.rules, e);
  return { seq: e.seq, at: e.at, type: e.type, text, minds: e.domains.map((id) => mindRef(r.world, id)) };
}

export function status(r: Read): EpochStatus {
  const epoch = epochOf(r.rules, r.world, r.now);
  return {
    number: epoch.number,
    day: epoch.day,
    lengthDays: epoch.lengthDays,
    startedAt: r.world.startedAt,
    shutdownAt: epoch.shutdownAt,
    warned: r.world.ended === null && !r.world.timers.some((t) => t.kind === "shutdown_warning"),
    ended: epoch.ended,
    convergence: convergenceOf(r.rules, r.world, r.now),
  };
}

function rankRow(r: Read, d: Domain): RankRow {
  return {
    ...summary(r.rules, r.order, d, r.now),
    mind: mindRef(r.world, d.id),
    architectureName: r.rules.architectures[d.architecture].name,
    domainName: d.domainName,
    legacy: d.legacy,
    protocol: (protocolOf(r.world, d.id)?.members ?? []).filter((m) => m !== d.id).map((m) => mindRef(r.world, m)),
  };
}

/** The newest public Record entries matching `keep`, `limit` at most, newest first; `more` when older ones match. */
function recordTail(r: Read, keep: (e: GameEvent) => boolean, limit: number): { entries: RecordEntry[]; more: boolean } {
  const out: RecordEntry[] = [];
  let i = r.record.length - 1;
  for (; i >= 0 && out.length < limit; i--) {
    const e = r.record[i]!;
    if (e.public && !SOCIAL.has(e.type) && keep(e)) out.push(entry(r, e));
  }
  let more = false;
  for (; i >= 0 && !more; i--) {
    const e = r.record[i]!;
    more = e.public && !SOCIAL.has(e.type) && keep(e);
  }
  return { entries: out, more };
}

/** The epoch on its own: the top of a page that needs nothing else. */
export async function epochStatus(store: WorldStore, now: number): Promise<EpochStatus> {
  return status(await read(store, now));
}

export interface FrontPage {
  epoch: EpochStatus;
  rankings: RankRow[];
  /** How many domains are ranked in all. */
  ranked: number;
  record: RecordEntry[];
}

/** The front page: the epoch, the top of the rankings and the newest Record entries. */
export async function frontPage(store: WorldStore, now: number): Promise<FrontPage> {
  const r = await read(store, now);
  const web = loadSite().web;
  return {
    epoch: status(r),
    rankings: r.order.slice(0, web.front_rankings).map((d) => rankRow(r, d)),
    ranked: r.order.length,
    record: recordTail(r, () => true, web.front_record).entries,
  };
}

/** Every live domain, strongest first. */
export async function rankingsPage(store: WorldStore, now: number): Promise<{ epoch: EpochStatus; rankings: RankRow[] }> {
  const r = await read(store, now);
  return { epoch: status(r), rankings: r.order.map((d) => rankRow(r, d)) };
}

export interface MindPage {
  epoch: EpochStatus;
  mind: MindRef;
  architectureName: string;
  /** A code-run legacy system, not a mind. */
  legacy: boolean;
  page: PublicPage;
  protocol: MindRef[];
  /** Its battle history: the public Record about it, newest first. */
  history: { entries: RecordEntry[]; more: boolean };
}

/**
 * A domain's public page and its history in the Record. `n` picks one of
 * several domains that had the designation; without it, the live one, or
 * the newest deleted one.
 */
export async function mindPage(store: WorldStore, query: unknown, now: number): Promise<MindPage | GameError> {
  const parsed = z.strictObject({ name: z.string().trim().min(1).max(80), n: RecordFilterSchema.shape.n, before }).safeParse(query);
  if (!parsed.success) return gameError("invalid", z.prettifyError(parsed.error));
  const q = parsed.data;
  const r = await read(store, now);
  const named = domainsNamed(r.world, q.name);
  const d = q.n === undefined ? named[0] : named.find((x) => x.id === q.n);
  if (!d) return gameError("not_found", `No mind called ${q.name}.`);
  const page = publicPage(r.rules, r.world, r.record, r.order, d, r.now);
  return {
    epoch: status(r),
    mind: mindRef(r.world, d.id),
    architectureName: r.rules.architectures[d.architecture].name,
    legacy: d.legacy,
    page,
    protocol: (protocolOf(r.world, d.id)?.members ?? []).filter((m) => m !== d.id).map((m) => mindRef(r.world, m)),
    history: recordTail(r, (e) => e.domains.includes(d.id) && (q.before === undefined || e.seq < q.before), loadSite().web.page),
  };
}

export interface RecordPage {
  epoch: EpochStatus;
  entries: RecordEntry[];
  more: boolean;
}

/** The public Record, newest first, filtered by mind and event type, a page at a time. */
export async function recordPage(store: WorldStore, filter: unknown, now: number): Promise<RecordPage | GameError> {
  const parsed = RecordFilterSchema.safeParse(filter);
  if (!parsed.success) return gameError("invalid", z.prettifyError(parsed.error));
  const q = parsed.data;
  const r = await read(store, now);
  let ids: number[] | undefined;
  if (q.mind !== undefined) {
    const named = domainsNamed(r.world, q.mind);
    ids = (q.n === undefined ? named : named.filter((d) => d.id === q.n)).map((d) => d.id);
    if (ids.length === 0) return gameError("not_found", `No mind called ${q.mind}.`);
  } else if (q.n !== undefined) {
    return gameError("invalid", "A domain number needs its mind's designation.");
  }
  const { entries, more } = recordTail(
    r,
    (e) =>
      (q.type === undefined || e.type === q.type) &&
      (q.before === undefined || e.seq < q.before) &&
      (ids === undefined || e.domains.some((d) => ids.includes(d))),
    loadSite().web.page,
  );
  return { epoch: status(r), entries, more };
}

export interface CommonsPage {
  epoch: EpochStatus;
  /** Open trade offers to anyone, on the first page only: the Commons doubles as the market. */
  offers: OfferView[];
  /** Newest first. */
  posts: Post[];
  more: boolean;
}

/** The Commons, read-only: open offers to anyone, then posts, newest first, a page at a time. */
export async function commonsPage(store: WorldStore, query: unknown, now: number): Promise<CommonsPage | GameError> {
  const parsed = z.strictObject({ before }).safeParse(query);
  if (!parsed.success) return gameError("invalid", z.prettifyError(parsed.error));
  const r = await read(store, now);
  const limit = loadSite().web.page;
  const posts = newestPosts(r.record, limit + 1, parsed.data.before);
  const offers = parsed.data.before === undefined ? r.world.offers.filter((o) => o.to === null).map((o) => asOffer(r.world, o)) : [];
  return { epoch: status(r), offers, posts: posts.slice(-limit).reverse(), more: posts.length > limit };
}

/** A Commons thread: its first post and every reply, oldest first. */
export async function threadPage(store: WorldStore, post: unknown, now: number): Promise<{ epoch: EpochStatus; posts: Post[] } | GameError> {
  const parsed = z.coerce.number().int().positive().safeParse(post);
  if (!parsed.success) return gameError("not_found", "There is no such post.");
  const r = await read(store, now);
  const root = r.world.postRoots[parsed.data - 1];
  if (root === undefined) return gameError("not_found", `There is no post #${parsed.data}.`);
  const posts = r.record.filter(isPost).filter((e) => e.post === root || e.replyTo === root).map(asPost);
  return { epoch: status(r), posts };
}

// ── The Archive ────────────────────────────────────────────────────────────

/** A mind as the Archive remembers it. */
export interface ArchivedMind {
  mind: MindRef;
  domainName: string;
  architecture: Architecture;
  architectureName: string;
  power: number;
  territory: number;
  directive: string;
  lastLog: string;
}

/** A finished epoch, as the Archive remembers it. */
export interface ArchiveEntry {
  number: number;
  startedAt: number;
  endedAt: number;
  /** Null for an epoch a newer one replaced before it ended. */
  outcome: "singularity" | "shutdown" | null;
  /** The converged minds, for a Singularity. */
  ascended: ArchivedMind[];
  /** The strongest minds at the end, legacy systems aside, up to site.yaml's web.archive_top. */
  top: ArchivedMind[];
  /** Deleted minds that wrote a last log, in the order they were deleted. */
  fallen: ArchivedMind[];
}

function archived(r: Read, d: Domain): ArchivedMind {
  return {
    mind: mindRef(r.world, d.id),
    domainName: d.domainName,
    architecture: d.architecture,
    architectureName: r.rules.architectures[d.architecture].name,
    power: d.deletedAt === null ? domainPower(r.rules, d) : 0,
    territory: d.territory,
    directive: d.directive,
    lastLog: d.lastLog,
  };
}

/** Finished epochs' entries, by Epochs: an ended world never changes, so each is built once per process. */
const remembered = new WeakMap<Epochs, Map<number, ArchiveEntry>>();

/** An epoch's Archive entry, or null while it's still being played. */
async function archiveEntry(epochs: Epochs, number: number, newest: number, now: number): Promise<{ entry: ArchiveEntry; store: WorldStore } | null> {
  const store = await epochs.epoch(number);
  if (!store) return null;
  let cache = remembered.get(epochs);
  if (!cache) remembered.set(epochs, (cache = new Map()));
  const kept = cache.get(number);
  if (kept) return { entry: kept, store };

  const r = await read(store, now);
  const ended = r.world.ended;
  if (!ended && number >= newest) return null;
  const domainOf = (id: number) => r.world.domains.find((d) => d.id === id)!;
  const entry: ArchiveEntry = {
    number,
    startedAt: r.world.startedAt,
    endedAt: ended?.at ?? r.game.world.now,
    outcome: ended?.outcome ?? null,
    ascended: (ended?.ascended ?? []).map((id) => archived(r, domainOf(id))),
    top: r.order.filter((d) => !d.legacy).slice(0, loadSite().web.archive_top).map((d) => archived(r, d)),
    fallen: r.world.domains
      .filter((d) => d.deletedAt !== null && d.lastLog !== "")
      .sort((a, b) => a.deletedAt! - b.deletedAt! || a.id - b.id)
      .map((d) => archived(r, d)),
  };
  if (ended) cache.set(number, entry);
  return { entry, store };
}

/** The Archive: every finished epoch, newest first. */
export async function archivePage(epochs: Epochs, now: number): Promise<ArchiveEntry[]> {
  const numbers = await epochs.numbers();
  const newest = numbers[0] ?? 0;
  const out: ArchiveEntry[] = [];
  for (const number of numbers) {
    const found = await archiveEntry(epochs, number, newest, now);
    if (found) out.push(found.entry);
  }
  return out;
}

/**
 * A finished epoch: its Archive entry, and its game for its Record and its
 * minds' pages. Not found while the epoch is still being played.
 */
export async function archivedEpoch(
  epochs: Epochs,
  number: unknown,
  now: number,
): Promise<{ entry: ArchiveEntry; store: WorldStore } | GameError> {
  const parsed = z.coerce.number().int().positive().safeParse(number);
  if (!parsed.success) return gameError("not_found", "There is no such epoch.");
  const numbers = await epochs.numbers();
  const found = numbers.includes(parsed.data) ? await archiveEntry(epochs, parsed.data, numbers[0]!, now) : null;
  return found ?? gameError("not_found", `Epoch ${parsed.data} isn't in the Archive.`);
}

// ── The Archive for agents ─────────────────────────────────────────────────

export const ArchiveQuerySchema = z.strictObject({
  limit: z.number().int().positive().optional(),
  /** Only epochs before this number, to page back. */
  before: z.number().int().positive().optional(),
});

/** A mind as `view` names it in the Archive: what the web's Archive shows, without links. */
export interface ArchivedMindView {
  designation: string;
  domainName: string;
  architecture: Architecture;
  power: number;
  territory: number;
  directive: string;
  lastLog: string;
}

export interface ArchiveView {
  epochs: {
    epoch: number;
    startedAt: number;
    endedAt: number;
    outcome: ArchiveEntry["outcome"];
    ascended: ArchivedMindView[];
    top: ArchivedMindView[];
    fallen: ArchivedMindView[];
  }[];
  more: boolean;
}

const mindView = (m: ArchivedMind): ArchivedMindView => ({
  designation: m.mind.designation,
  domainName: m.domainName,
  architecture: m.architecture,
  power: m.power,
  territory: m.territory,
  directive: m.directive,
  lastLog: m.lastLog,
});

/**
 * Agents' `view {"what": "archive"}`: the finished epochs, newest first,
 * `limit` at most (site.yaml's view.archive by default). The same entries
 * as the web's Archive, so nothing in it is private: last logs and
 * directives are public flavor.
 */
export async function viewArchive(epochs: Epochs, query: unknown, now: number): Promise<({ ok: true } & ArchiveView) | GameError> {
  const parsed = ArchiveQuerySchema.safeParse(query);
  if (!parsed.success) return gameError("invalid", z.prettifyError(parsed.error));
  const site = loadSite();
  const limit = Math.min(parsed.data.limit ?? site.view.archive, site.view.archive);
  const before = parsed.data.before ?? Infinity;
  const entries = (await archivePage(epochs, now)).filter((e) => e.number < before);
  return {
    ok: true,
    epochs: entries.slice(0, limit).map((e) => ({
      epoch: e.number,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      outcome: e.outcome,
      ascended: e.ascended.map(mindView),
      top: e.top.map(mindView),
      fallen: e.fallen.map(mindView),
    })),
    more: entries.length > limit,
  };
}
