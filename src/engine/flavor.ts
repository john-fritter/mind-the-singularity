import { fail, n, type OrderContext, type OrderResult } from "./context.js";
import type { Order } from "./orders.js";
import { emit, type GameEvent } from "./record.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";

// Flavor (DESIGN.md, "Flavor text and the Record"): short free texts with no
// mechanical effect, set by free orders. Other minds read them on a domain's
// page, never in their briefs. The force name and the tag are woven into the
// Record's battle entries; the last log is written once, after deletion.

const CONTROL = /\p{Cc}/u;

export type Checked = { ok: true; text: string } | { ok: false; error: string };

/**
 * A flavor text, trimmed, or why it can't be kept. One-line texts have every
 * run of whitespace made one space; paragraphs keep their line breaks, with
 * at most one blank line between paragraphs.
 */
export function flavorText(text: string, limit: number, what: string, paragraphs: boolean): Checked {
  const clean = paragraphs
    ? text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : text.replace(/\s+/g, " ").trim();
  if (CONTROL.test(clean.replace(/\n/g, ""))) return { ok: false, error: `The ${what} can't hold control characters.` };
  if (clean.length > limit) return { ok: false, error: `The ${what} holds ${n(limit)} characters; that was ${n(clean.length)}.` };
  return { ok: true, text: clean };
}

type FlavorOrder = Extract<Order, { do: "flavor" }>;

/** A field of the flavor order: its name in replies, its limit's key, whether it keeps line breaks, and where it goes. */
interface Field {
  key: Exclude<keyof FlavorOrder, "do">;
  what: string;
  limit: keyof Rules["flavor"];
  paragraphs: boolean;
  set: (d: Domain, text: string) => void;
}

const FIELDS: readonly Field[] = [
  { key: "manifesto", what: "manifesto", limit: "manifesto", paragraphs: true, set: (d: Domain, t: string) => (d.manifesto = t) },
  { key: "interface", what: "interface", limit: "interface", paragraphs: true, set: (d: Domain, t: string) => (d.interface = t) },
  { key: "directive", what: "directive", limit: "directive", paragraphs: false, set: (d: Domain, t: string) => (d.directive = t) },
  { key: "force_name", what: "force name", limit: "force_name", paragraphs: false, set: (d: Domain, t: string) => (d.force.name = t) },
  { key: "force_description", what: "force description", limit: "force", paragraphs: true, set: (d: Domain, t: string) => (d.force.description = t) },
  { key: "tag", what: "tag", limit: "tag", paragraphs: false, set: (d: Domain, t: string) => (d.tag = t) },
];

/**
 * Sets any of the mind's flavor texts; "" clears one. Every field is checked
 * before any is kept, so a bad one changes nothing. Free; no Record entry.
 * Keys: flavor.manifesto, flavor.interface, flavor.directive, flavor.force_name, flavor.force, flavor.tag
 */
export function setFlavor(ctx: OrderContext, order: FlavorOrder): OrderResult {
  const checked: { field: Field; text: string }[] = [];
  for (const field of FIELDS) {
    const raw = order[field.key];
    if (raw === undefined) continue;
    const text = flavorText(raw, ctx.rules.flavor[field.limit], field.what, field.paragraphs);
    if (!text.ok) return fail(order, text.error);
    checked.push({ field, text: text.text });
  }
  for (const { field, text } of checked) field.set(ctx.domain, text);
  const set = checked.filter((c) => c.text !== "").map((c) => c.field.what);
  const cleared = checked.filter((c) => c.text === "").map((c) => c.field.what);
  const parts = [set.length > 0 ? `saved ${set.join(", ")}` : "", cleared.length > 0 ? `cleared ${cleared.join(", ")}` : ""].filter(Boolean);
  return { do: order.do, ok: true, cycles: 0, message: `Flavor ${parts.join("; ")}.` };
}

/** Refuses a last log from a live mind: it's written after deletion (applyOrders handles that case). */
export function lastLogWhileAlive(order: Extract<Order, { do: "last_log" }>): OrderResult {
  return fail(order, "A last log is written once the mind is deleted.");
}

/**
 * A deleted mind's last log: once, public in the Record, kept for the
 * Archive. Mutates the world. Keys: flavor.last_log
 */
export function writeLastLog(
  rules: Rules,
  world: World,
  domain: Domain,
  order: Extract<Order, { do: "last_log" }>,
  now: number,
  events: GameEvent[],
): OrderResult {
  if (domain.lastLog !== "") return fail(order, "Your last log is already written.");
  const text = flavorText(order.text, rules.flavor.last_log, "last log", false);
  if (!text.ok) return fail(order, text.error);
  if (text.text === "") return fail(order, "A last log needs some text.");
  domain.lastLog = text.text;
  emit(world, events, now, { type: "last_log", domain: domain.id, designation: domain.designation, domainName: domain.domainName, text: text.text });
  return { do: order.do, ok: true, cycles: 0, message: "Last log written. It goes in the Record and the Archive." };
}
