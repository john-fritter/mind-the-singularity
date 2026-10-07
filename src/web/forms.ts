// The play pages' forms, read into what an agent would send: a list of
// orders for submitOrders, or a boot input for bootMind. This only shapes
// the input; the engine parses and checks it, so a form can't do anything
// the JSON can't, and the refusal a person sees is the one an agent gets.

export type Form = Record<string, string>;

/** Fields that hold a whole number. */
const NUMBERS = new Set(["cycles", "count"]);

/** The fields each order form sends, beyond `do`. */
const FIELDS: Record<string, readonly string[]> = {
  expand: ["cycles"],
  build: ["building", "count"],
  manufacture: ["unit", "count"],
  monetize: ["cycles"],
  spin_up: ["cycles"],
  set_research: ["program"],
  execute: ["program", "target"],
  attack: ["target", "mode", "program"],
  set_countermeasure: ["program", "above"],
  scratchpad: ["text"],
  last_log: ["text"],
};

/** A form's text fields; files and repeated keys aren't part of any form here. */
export function formFields(body: Record<string, unknown>): Form {
  const out: Form = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

const number = (text: string): number | string => (/^\s*-?\d+\s*$/.test(text) ? Number(text) : text);

/**
 * The orders a form sends: the JSON box's list as it is, or one order from
 * an order form. Blank fields are left out, as an agent would leave them
 * out, except the texts, where blank means "clear it".
 */
export function ordersFromForm(form: Form): { orders: unknown[] } | { error: string } {
  const kind = form["do"] ?? "";
  if (kind === "json") {
    try {
      const parsed: unknown = JSON.parse(form["orders"] ?? "");
      return { orders: Array.isArray(parsed) ? parsed : [parsed] };
    } catch {
      return { error: "That isn't JSON: write a list of orders, as an agent would." };
    }
  }
  const fields = FIELDS[kind];
  if (!fields) return { error: "That form isn't one this page has." };
  const order: Record<string, unknown> = { do: kind };
  for (const key of fields) {
    const value = form[key] ?? "";
    if (key === "text") order[key] = value;
    else if (value.trim() === "") continue;
    else if (key === "above") order[key] = Number(value) / 100;
    else order[key] = NUMBERS.has(key) ? number(value) : value.trim();
  }
  // A countermeasure with no program clears it.
  if (kind === "set_countermeasure" && order["program"] === undefined) {
    order["program"] = null;
    delete order["above"];
  }
  return { orders: [order] };
}

/** The boot form, as boot_mind's input. */
export function bootFromForm(form: Form): Record<string, string> {
  return {
    designation: form["designation"] ?? "",
    domainName: form["domainName"] ?? "",
    architecture: form["architecture"] ?? "",
    manifesto: form["manifesto"] ?? "",
  };
}
