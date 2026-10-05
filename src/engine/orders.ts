import { z } from "zod";

// The orders a mind can give, as JSON. DESIGN.md: "A JSON list, run top to
// bottom. Each order succeeds or fails with a reason." Each order is parsed
// on its own, so one malformed order fails without taking the rest with it.
//
// Buildings, units and programs are named by id or display name; the engine
// resolves them (names.ts). Lengths that come from the rules (the
// scratchpad's) are checked by the engine, since this schema is static.

const label = z.string().min(1).max(80);
const amount = z.number().int().positive();
/** How many cycles to spend on a repeatable action. */
const cycles = amount.default(1);
const counts = z.record(label, amount);

/** One kind ({building, count}) or several ({buildings: {city: 5, lab: 5}}), not both. */
const oneOrMany = (one: unknown, count: unknown, many: unknown) =>
  one !== undefined && count !== undefined ? many === undefined : one === undefined && count === undefined && many !== undefined;

export const OrderSchema = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("expand"), cycles }),
  z
    .strictObject({
      do: z.literal("build"),
      building: label.optional(),
      count: amount.optional(),
      buildings: counts.optional(),
    })
    .refine((o) => oneOrMany(o.building, o.count, o.buildings), { message: "give building and count, or buildings" }),
  z
    .strictObject({ do: z.literal("manufacture"), unit: label.optional(), count: amount.optional(), units: counts.optional() })
    .refine((o) => oneOrMany(o.unit, o.count, o.units), { message: "give unit and count, or units" }),
  z.strictObject({ do: z.literal("monetize"), cycles }),
  z.strictObject({ do: z.literal("spin_up"), cycles }),
  z.strictObject({ do: z.literal("execute"), program: label, target: label.optional() }),
  z.strictObject({
    do: z.literal("attack"),
    target: label,
    mode: z.enum(["conquest", "raid"]),
    /** A battle program to run with the attack. */
    program: label.optional(),
  }),
  z
    .strictObject({
      do: z.literal("set_countermeasure"),
      program: label.nullable(),
      /** Fires when the attacker's attack exceeds this share of the domain's defense. */
      above: z.number().min(0).max(2).optional(),
    })
    .refine((o) => o.program === null || o.above !== undefined, { message: "give above with a program" }),
  z.strictObject({ do: z.literal("set_research"), program: label }),
  z.strictObject({ do: z.literal("scratchpad"), text: z.string() }),
]);

export type Order = z.infer<typeof OrderSchema>;
export type OrderKind = Order["do"];

export type Parsed = { ok: true; order: Order } | { ok: false; error: string };

/** Parses one order, with a short error naming what's wrong. */
export function parseOrder(raw: unknown): Parsed {
  const result = OrderSchema.safeParse(raw);
  if (result.success) return { ok: true, order: result.data };
  const issue = result.error.issues[0]!;
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { ok: false, error: `${where}${issue.message}` };
}
