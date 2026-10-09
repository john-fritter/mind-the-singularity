import type { AdminEntry, AdminLogEntry, AdminMessage, AdminMindRow } from "../game/admin.js";
import type { BotRun } from "../game/bots.js";
import type { MindRef } from "../game/public.js";
import { isoAt } from "./format.js";

// The admin view's downloads: its lists as CSV or JSON files, every match
// of the page's filters, oldest first. Times are ISO UTC. Minds are named by
// designation, with "#<domain>" when two domains of an epoch shared it.

type Cell = string | number | boolean | null | undefined;

/**
 * A text cell a spreadsheet would read as a formula (=, +, -, @, tab or
 * carriage return first) gets a leading apostrophe: the minds write these
 * texts, and opening a download mustn't run what they wrote.
 */
const defused = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? defused(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV: a header line, then a line per row, CRLF line ends. */
export function csv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export const mindName = (m: MindRef) => (m.n === null ? m.designation : `${m.designation}#${m.n}`);

const json = (v: unknown) => JSON.stringify(v) ?? "";

export function recordCsv(entries: AdminEntry[]): string {
  return csv(
    ["seq", "time", "day", "type", "public", "minds", "text"],
    entries.map((e) => [e.seq, isoAt(e.at), e.day, e.type, e.public, e.minds.map(mindName).join(" "), e.text]),
  );
}

export function recordJson(entries: AdminEntry[]): unknown[] {
  return entries.map((e) => ({
    seq: e.seq,
    time: isoAt(e.at),
    day: e.day,
    type: e.type,
    public: e.public,
    minds: e.minds.map(mindName),
    text: e.text,
    event: e.raw,
  }));
}

export function channelsCsv(messages: AdminMessage[]): string {
  return csv(
    ["seq", "time", "day", "from", "to", "text"],
    messages.map((m) => [m.seq, isoAt(m.at), m.day, mindName(m.from), mindName(m.to), m.text]),
  );
}

export function channelsJson(messages: AdminMessage[]): unknown[] {
  return messages.map((m) => ({ seq: m.seq, time: isoAt(m.at), day: m.day, from: mindName(m.from), to: mindName(m.to), text: m.text }));
}

/** One row per order (a boot is one row, its input as the order), so a spreadsheet can filter and count them. */
export function ordersCsv(entries: AdminLogEntry[]): string {
  const rows: Cell[][] = [];
  for (const e of entries) {
    const head = [e.index, isoAt(e.at), e.day, e.account, mindName(e.mind), e.kind];
    if (e.kind === "boot") rows.push([...head, null, "boot", json(e.input), true, null, null]);
    for (const o of e.orders) rows.push([...head, o.n, o.type, json(o.order), o.result?.ok ?? null, o.result?.message ?? null, o.result?.cycles ?? null]);
  }
  return csv(["index", "time", "day", "account", "mind", "kind", "n", "order_type", "order", "ok", "message", "cycles"], rows);
}

export function ordersJson(entries: AdminLogEntry[]): unknown[] {
  return entries.map((e) => ({
    index: e.index,
    time: isoAt(e.at),
    day: e.day,
    account: e.account,
    mind: mindName(e.mind),
    kind: e.kind,
    ...(e.kind === "boot" ? { input: e.input } : { orders: e.orders.map((o) => ({ n: o.n, order: o.order, result: o.result })) }),
  }));
}

export function mindsCsv(rows: AdminMindRow[]): string {
  return csv(
    ["rank", "mind", "owner", "architecture", "legacy", "status", "power", "cycles", "capital", "compute", "users", "territory", "orders", "refused", "last_order", "deleted_at", "scratchpad_chars"],
    rows.map((r) => [
      r.summary.rank,
      mindName(r.mind),
      r.owner,
      r.status.architecture,
      r.legacy,
      r.summary.status,
      r.status.power,
      r.status.cycles,
      r.status.capital,
      r.status.compute,
      r.status.users,
      r.status.territory,
      r.orders,
      r.refused,
      r.lastOrderAt === null ? null : isoAt(r.lastOrderAt),
      r.deletedAt === null ? null : isoAt(r.deletedAt),
      r.scratchpadChars,
    ]),
  );
}

const WAKES_HEADER = [
  "id",
  "time",
  "bot",
  "day",
  "slot",
  "outcome",
  "model",
  "booted",
  "model_calls",
  "prompt_tokens",
  "completion_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "orders_ok",
  "orders",
  "error",
];

/** A wake's orders carried out and given, from its results. */
function wakeOrders(r: BotRun): [number | null, number | null] {
  const results = (r.detail?.results as { results?: { ok: boolean }[] } | null | undefined)?.results;
  return results ? [results.filter((x) => x.ok).length, results.length] : [null, null];
}

export const wakesCsvHeader = () => csv(WAKES_HEADER, []);

/** Wakes as CSV lines without the header, for a download written a batch at a time. */
export function wakesCsvRows(runs: BotRun[]): string {
  if (runs.length === 0) return "";
  return runs
    .map((r) =>
      [
        r.id,
        isoAt(r.at),
        r.bot,
        r.day,
        r.slot,
        r.outcome,
        r.model,
        r.booted,
        r.modelCalls,
        r.promptTokens,
        r.completionTokens,
        r.reasoningTokens,
        r.cachedTokens,
        ...wakeOrders(r),
        r.error,
      ]
        .map(cell)
        .join(","),
    )
    .join("\r\n")
    .concat("\r\n");
}

export const wakeJson = (r: BotRun) => ({ ...r, at: isoAt(r.at) });
