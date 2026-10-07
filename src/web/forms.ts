// The play pages' forms, read into what an agent would send: a list of
// orders for submitOrders, or a boot input for bootMind. This only shapes
// the input; the engine parses and checks it, so a form can't do anything
// the JSON can't, and the refusal a person sees is the one an agent gets.

export type Form = Record<string, string>;

/** Fields that hold a whole number. */
const NUMBERS = new Set(["cycles", "count", "reply_to", "offer", "proposal"]);

/** Fields that hold free text, kept as written: blank clears one. */
const TEXTS = new Set(["text", "manifesto", "interface", "directive", "force_name", "force_description", "tag"]);

/** The goods a trade's side may name. */
const GOODS = new Set(["capital", "compute"]);

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
  post: ["text", "reply_to"],
  message: ["to", "text"],
  trade_accept: ["offer"],
  trade_cancel: ["offer"],
  protocol_propose: ["to"],
  protocol_accept: ["proposal"],
  protocol_decline: ["proposal"],
  protocol_revoke: [],
  flavor: ["manifesto", "interface", "directive", "force_name", "force_description", "tag"],
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
  if (kind === "trade_offer") return tradeOffer(form);
  // Leaving a protocol is announced to everyone and can't be taken back, so the form asks twice.
  if (kind === "protocol_revoke" && form["confirm"] !== "yes") return { error: "Tick the box to confirm you mean to leave your protocol." };
  const fields = FIELDS[kind];
  if (!fields) return { error: "That form isn't one this page has." };
  const order: Record<string, unknown> = { do: kind };
  for (const key of fields) {
    // A flavor field the form leaves out, or sends as it was (`was_<field>`), isn't changed; any other text is sent even blank.
    if (TEXTS.has(key)) {
      if (kind !== "flavor" || (key in form && form[key] !== form[`was_${key}`])) order[key] = form[key] ?? "";
      continue;
    }
    const value = (form[key] ?? "").trim();
    if (value === "") continue;
    if (key === "above") order[key] = Number(value) / 100;
    else order[key] = NUMBERS.has(key) ? number(value) : value;
  }
  if (kind === "flavor" && Object.keys(order).length === 1) return { error: "Nothing changed." };
  // A countermeasure with no program clears it.
  if (kind === "set_countermeasure" && order["program"] === undefined) {
    order["program"] = null;
    delete order["above"];
  }
  return { orders: [order] };
}

/** The trade form: what you give and what you want, each goods and an amount, and optionally to whom. */
function tradeOffer(form: Form): { orders: unknown[] } | { error: string } {
  const side = (which: "give" | "want"): Record<string, unknown> | null => {
    const goods = form[`${which}_goods`] ?? "";
    return GOODS.has(goods) ? { [goods]: number(form[`${which}_amount`] ?? "") } : null;
  };
  const give = side("give");
  const want = side("want");
  if (!give || !want) return { error: "Name capital or compute for each side of the trade." };
  const to = (form["to"] ?? "").trim();
  return { orders: [{ do: "trade_offer", give, want, ...(to ? { to } : {}) }] };
}

/** Where a form sends you back to: the play page it was on, or the dashboard. */
export function backTo(form: Form): string {
  const back = form["back"] ?? "";
  if (!/^\/play(\/[A-Za-z0-9_.~%-]+)*$/.test(back)) return "/play";
  // No "." or ".." step, written plainly or percent-encoded, which would climb out of /play.
  const steps = back.split("/").slice(2).map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return ".";
    }
  });
  return steps.some((x) => x === "." || x === ".." || x.includes("/")) ? "/play" : back;
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
