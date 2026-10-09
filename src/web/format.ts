// How the web view writes numbers, times and goods. Every page uses these,
// so the site reads the same everywhere.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "5 Oct 2026, 14:30 UTC". Always UTC: the game runs on one clock for everyone. */
export function formatAt(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "5 Oct 14:30": a moment in a narrow column, UTC like the rest. */
export function formatShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "10 Oct": a day, for lists of days. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The moment as an ISO string, for <time datetime>. */
export const isoAt = (ms: number) => new Date(ms).toISOString();

/** "12,345". */
export const num = (n: number) => Math.round(n).toLocaleString("en-US");

/** "1,000 capital". */
export const lot = (l: { goods: string; amount: number }) => `${num(l.amount)} ${l.goods}`;

/** An event type as a reader would say it: "protocol_signed" is "protocol signed". */
export const typeLabel = (type: string) => type.replace(/_/g, " ");

/** A list of names: "A", "A and B", "A, B and C". */
export function names(list: string[]): string {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}
