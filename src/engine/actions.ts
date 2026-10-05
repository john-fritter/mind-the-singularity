import { PROGRAM_INFO, programsOf, type Building, type Hardware, type Program, type Tier } from "./architectures.js";
import { HOUR_MS } from "./cycles.js";
import { addCompute, cycleIncome, passCycle, type UpkeepLosses } from "./cycle.js";
import { capability, housingRoom, openLand, singularityUnlocked } from "./domain.js";
import { buildingCost, buildRate, expansionYield, manufactureCapacity, monetizeYield, spinUpYield } from "./economy.js";
import { buildingName, programName, resolveBuilding, resolveProgram, resolveUnit, unitName } from "./names.js";
import type { Order } from "./orders.js";
import { deployCount, programCompute, programCrashChance, researchCost, scaledShare } from "./programs.js";
import type { GameEvent } from "./record.js";
import type { Rng } from "./rng.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";

// What each order does. Every function here mutates the world it's given;
// world.ts hands them a copy. An order that can't do anything fails without
// spending a cycle. One that can do part of what was asked does that part
// and says why it stopped.

export interface OrderContext {
  rules: Rules;
  world: World;
  domain: Domain;
  now: number;
  events: GameEvent[];
  /** Seeded for this order (see rng.ts). */
  rng: Rng;
  losses: UpkeepLosses;
}

export interface OrderResult {
  do: string;
  ok: boolean;
  /** Cycles the order spent. */
  cycles: number;
  message: string;
}

const n = (x: number) => x.toLocaleString("en-US");
const fail = (order: { do: string }, message: string): OrderResult => ({ do: order.do, ok: false, cycles: 0, message });
const outOfCycles = (order: { do: string }, cost: number, have: number): OrderResult =>
  fail(order, `Out of cycles: this costs ${cost}, ${have} left.`);

/** Spends cycles, running one cycle's economy for each. */
function spend(ctx: OrderContext, cycles: number): void {
  for (let i = 0; i < cycles; i++) {
    ctx.domain.cycles--;
    passCycle(ctx.rules, ctx.world, ctx.domain, ctx.now, ctx.events, ctx.losses);
  }
}

/** Runs a repeatable one-cycle-cost action up to `cycles` cycles' worth. Returns the cycles spent. */
function repeat(ctx: OrderContext, cost: number, cycles: number, step: () => void): number {
  let spent = 0;
  while (spent + cost <= cycles && ctx.domain.cycles >= cost) {
    step();
    spend(ctx, cost);
    spent += cost;
  }
  return spent;
}

/** " Stopped after N of M cycles: out of cycles." when an order ran short. */
const shortBy = (spent: number, wanted: number) =>
  spent < wanted ? ` Stopped after ${spent} of ${wanted} cycles: out of cycles.` : "";

function expand(ctx: OrderContext, order: Extract<Order, { do: "expand" }>): OrderResult {
  const cost = ctx.rules.action_cycles.expand;
  if (ctx.domain.cycles < cost) return outOfCycles(order, cost, ctx.domain.cycles);
  let gained = 0;
  const spent = repeat(ctx, cost, order.cycles, () => {
    const sectors = expansionYield(ctx.rules, ctx.domain.territory);
    ctx.domain.territory += sectors;
    gained += sectors;
  });
  if (spent === 0) return fail(order, `Expanding costs ${cost} cycles.`);
  return {
    do: order.do,
    ok: true,
    cycles: spent,
    message: `Expanded: +${n(gained)} sectors, territory ${n(ctx.domain.territory)}.${shortBy(spent, order.cycles)}`,
  };
}

/** Resolves {building, count} or {buildings} to ids, in the order given. */
function wanted<T extends string>(
  single: string | undefined,
  count: number | undefined,
  many: Record<string, number> | undefined,
  resolve: (text: string) => T | undefined,
): { ok: true; wanted: Map<T, number> } | { ok: false; unknown: string } {
  const entries = single !== undefined ? [[single, count!] as const] : Object.entries(many ?? {});
  const out = new Map<T, number>();
  for (const [text, k] of entries) {
    const id = resolve(text);
    if (!id) return { ok: false, unknown: text };
    out.set(id, (out.get(id) ?? 0) + k);
  }
  return { ok: true, wanted: out };
}

const listCounts = (counts: Map<string, number>, nameOf: (id: string) => string) =>
  [...counts].map(([id, k]) => `${nameOf(id)} ×${n(k)}`).join(", ");

/**
 * Fills batches from `want`, one batch per `cost` cycles, until it's all made,
 * cycles run out, or a batch hits a limit other than its size. `place` makes
 * one of an id or returns why it can't.
 */
function batches<T extends string>(
  ctx: OrderContext,
  cost: number,
  want: Map<T, number>,
  batchSize: () => number,
  place: (id: T) => string | undefined,
): { made: Map<T, number>; spent: number; stopped?: string } {
  const made = new Map<T, number>();
  let spent = 0;
  let remaining = [...want.values()].reduce((a, b) => a + b, 0);
  while (remaining > 0) {
    if (ctx.domain.cycles < cost) return { made, spent, stopped: "out of cycles" };
    let room = batchSize();
    let placed = 0;
    let stopped: string | undefined;
    for (const [id, left] of want) {
      let k = left;
      while (k > 0 && room > 0) {
        const why = place(id);
        if (why) {
          stopped ??= why;
          break;
        }
        k--;
        room--;
        placed++;
        made.set(id, (made.get(id) ?? 0) + 1);
      }
      want.set(id, k);
      remaining -= left - k;
    }
    if (placed === 0) return { made, spent, stopped: stopped ?? "nothing could be made" };
    spend(ctx, cost);
    spent += cost;
    if (stopped) return { made, spent, stopped };
  }
  return { made, spent };
}

function build(ctx: OrderContext, order: Extract<Order, { do: "build" }>): OrderResult {
  const { rules, domain } = ctx;
  const parsed = wanted(order.building, order.count, order.buildings, (t) => resolveBuilding(rules, t));
  if (!parsed.ok) return fail(order, `No such building: ${parsed.unknown}.`);
  const cost = rules.action_cycles.build;
  if (domain.cycles < cost) return outOfCycles(order, cost, domain.cycles);
  const asked = new Map(parsed.wanted);
  const { made, spent, stopped } = batches(ctx, cost, parsed.wanted, () => buildRate(rules, domain.territory), (b) => {
    if (openLand(domain) <= 0) return "no open land";
    const price = buildingCost(rules, b, domain.territory);
    if (domain.capital < price) return `not enough capital (${buildingName(rules, b)} costs ${n(price)})`;
    domain.capital -= price;
    domain.buildings[b]++;
    return undefined;
  });
  const name = (b: string) => buildingName(rules, b as Building);
  if (spent === 0) return fail(order, `Built nothing: ${stopped}.`);
  const total = [...asked.values()].reduce((a, b) => a + b, 0);
  const done = [...made.values()].reduce((a, b) => a + b, 0);
  return {
    do: order.do,
    ok: true,
    cycles: spent,
    message: `Built ${listCounts(made, name)}.${done < total ? ` Stopped at ${n(done)} of ${n(total)}: ${stopped}.` : ""}`,
  };
}

function manufacture(ctx: OrderContext, order: Extract<Order, { do: "manufacture" }>): OrderResult {
  const { rules, domain } = ctx;
  const parsed = wanted(order.unit, order.count, order.units, (t) => resolveUnit(rules, t));
  if (!parsed.ok) return fail(order, `No such unit: ${parsed.unknown}.`);
  for (const unit of parsed.wanted.keys()) {
    if (!(unit in rules.hardware)) {
      return fail(order, `${unitName(rules, unit)} are deployed by running their program, not manufactured.`);
    }
  }
  const cost = rules.action_cycles.manufacture;
  if (domain.cycles < cost) return outOfCycles(order, cost, domain.cycles);
  const want = parsed.wanted as Map<Hardware, number>;
  const asked = [...want.values()].reduce((a, b) => a + b, 0);
  const { made, spent, stopped } = batches(ctx, cost, want, () => manufactureCapacity(rules, domain.buildings.factory), (h) => {
    const stats = rules.hardware[h];
    if (housingRoom(rules, domain) <= 0) return "no factory housing left";
    if (domain.capital < stats.capital) return `not enough capital (${stats.name} cost ${n(stats.capital)})`;
    if (domain.users < stats.users) return `not enough users to operate ${stats.name}`;
    domain.capital -= stats.capital;
    domain.users -= stats.users;
    domain.units[h] = (domain.units[h] ?? 0) + 1;
    return undefined;
  });
  if (spent === 0) return fail(order, `Manufactured nothing: ${stopped}.`);
  const done = [...made.values()].reduce((a, b) => a + b, 0);
  return {
    do: order.do,
    ok: true,
    cycles: spent,
    message: `Manufactured ${listCounts(made, (h) => rules.hardware[h as Hardware].name)}.${done < asked ? ` Stopped at ${n(done)} of ${n(asked)}: ${stopped}.` : ""}`,
  };
}

function monetize(ctx: OrderContext, order: Extract<Order, { do: "monetize" }>): OrderResult {
  const cost = ctx.rules.action_cycles.monetize;
  if (ctx.domain.cycles < cost) return outOfCycles(order, cost, ctx.domain.cycles);
  let gained = 0;
  const spent = repeat(ctx, cost, order.cycles, () => {
    const extra = Math.floor(monetizeYield(ctx.rules, cycleIncome(ctx.rules, ctx.domain, ctx.now).capital));
    ctx.domain.capital += extra;
    gained += extra;
  });
  if (spent === 0) return fail(order, `Monetizing costs ${cost} cycles.`);
  return { do: order.do, ok: true, cycles: spent, message: `Monetized: +${n(gained)} capital.${shortBy(spent, order.cycles)}` };
}

function spinUp(ctx: OrderContext, order: Extract<Order, { do: "spin_up" }>): OrderResult {
  const cost = ctx.rules.action_cycles.spin_up;
  if (ctx.domain.cycles < cost) return outOfCycles(order, cost, ctx.domain.cycles);
  let gained = 0;
  const spent = repeat(ctx, cost, order.cycles, () => {
    const before = ctx.domain.compute;
    addCompute(ctx.rules, ctx.domain, spinUpYield(ctx.rules, cycleIncome(ctx.rules, ctx.domain, ctx.now).compute));
    gained += ctx.domain.compute - before;
  });
  if (spent === 0) return fail(order, `Spinning up costs ${cost} cycles.`);
  return { do: order.do, ok: true, cycles: spent, message: `Spun up: +${n(gained)} compute.${shortBy(spent, order.cycles)}` };
}

/** A self program's duration, if it has one. Keys: architectures.<a>.programs.<id>.duration */
function selfDuration(rules: Rules, program: Program): { unit: "cycles" | "hours"; length: number } | undefined {
  const info = PROGRAM_INFO.get(program)!;
  const programs = rules.architectures[info.architecture!].programs as Record<string, { duration?: { unit: "cycles" | "hours"; length: number } }>;
  return programs[program]?.duration;
}

/** Starts a self program with a duration, replacing a run already going. */
function startRunning(ctx: OrderContext, program: Program, duration: { unit: "cycles" | "hours"; length: number }): string {
  const { world, domain, now } = ctx;
  domain.running = domain.running.filter((r) => r.program !== program);
  world.timers = world.timers.filter((t) => !(t.kind === "program_ends" && t.domain === domain.id && t.program === program));
  if (duration.unit === "cycles") {
    domain.running.push({ program, cyclesLeft: duration.length });
    return `for the next ${n(duration.length)} cycles spent`;
  }
  const endsAt = now + Math.round(duration.length * HOUR_MS);
  domain.running.push({ program, endsAt });
  world.timers.push({ id: world.nextTimerId++, at: endsAt, kind: "program_ends", domain: domain.id, program });
  return `for ${n(duration.length)} hours`;
}

function execute(ctx: OrderContext, order: Extract<Order, { do: "execute" }>): OrderResult {
  const { rules, domain } = ctx;
  const program = resolveProgram(rules, order.program);
  if (!program) return fail(order, `No such program: ${order.program}.`);
  const name = programName(rules, program);
  if (!domain.known.includes(program)) return fail(order, `You don't know ${name}.`);
  const info = PROGRAM_INFO.get(program)!;
  if (info.kind !== "deploy" && info.kind !== "self") return fail(order, `${name} can't be executed yet.`);

  const cycles = rules.action_cycles.execute;
  if (domain.cycles < cycles) return outOfCycles(order, cycles, domain.cycles);
  const compute = programCompute(rules, program);
  if (domain.compute < compute) return fail(order, `${name} needs ${n(compute)} compute; you have ${n(domain.compute)}.`);

  domain.compute -= compute;
  const cap = capability(domain);
  if (ctx.rng.next() < programCrashChance(rules, program, cap)) {
    spend(ctx, cycles);
    return { do: order.do, ok: false, cycles, message: `${name} crashed: ${n(compute)} compute spent, nothing happened.` };
  }

  let message: string;
  if (info.kind === "deploy") {
    const arrived = deployCount(rules, info.deployTier as Tier, cap);
    domain.units[program as keyof typeof domain.units] = (domain.units[program as keyof typeof domain.units] ?? 0) + arrived;
    message = `Deployed ${n(arrived)} ${name}.`;
  } else if (program === "assimilation") {
    const a = rules.architectures.assimilator.programs.assimilation;
    const converted = Math.floor(domain.users * scaledShare(rules, a.user_share, cap));
    const before = domain.compute;
    domain.users -= converted;
    addCompute(rules, domain, converted * a.compute_per_user);
    message = `${name}: ${n(converted)} users converted into ${n(domain.compute - before)} compute.`;
  } else {
    const duration = selfDuration(rules, program);
    if (!duration) throw new Error(`self program without a duration or effect: ${program}`);
    message = `${name} running ${startRunning(ctx, program, duration)}.`;
  }
  spend(ctx, cycles);
  return { do: order.do, ok: true, cycles, message };
}

function setResearch(ctx: OrderContext, order: Extract<Order, { do: "set_research" }>): OrderResult {
  const { rules, domain } = ctx;
  const program = resolveProgram(rules, order.program);
  if (!program) return fail(order, `No such program: ${order.program}.`);
  const name = programName(rules, program);
  if (!programsOf(domain.architecture).some((p) => p.id === program)) {
    return fail(order, `${name} isn't one of a ${rules.architectures[domain.architecture].name} mind's programs.`);
  }
  if (domain.known.includes(program)) return fail(order, `You already know ${name}.`);
  if (program === "singularity" && !singularityUnlocked(domain)) {
    return fail(order, `${name} can be researched only once every other program is known.`);
  }
  domain.researchTarget = program;
  const progress = domain.researchProgress[program] ?? 0;
  return {
    do: order.do,
    ok: true,
    cycles: 0,
    message: `Researching ${name}: ${n(progress)} of ${n(researchCost(rules, program))} points.`,
  };
}

function scratchpad(ctx: OrderContext, order: Extract<Order, { do: "scratchpad" }>): OrderResult {
  const limit = ctx.rules.flavor.scratchpad;
  if (order.text.length > limit) return fail(order, `The scratchpad holds ${n(limit)} characters; that was ${n(order.text.length)}.`);
  ctx.domain.scratchpad = order.text;
  return { do: order.do, ok: true, cycles: 0, message: "Scratchpad saved." };
}

/** Applies one parsed order. Mutates the context's world. */
export function applyOrder(ctx: OrderContext, order: Order): OrderResult {
  switch (order.do) {
    case "expand":
      return expand(ctx, order);
    case "build":
      return build(ctx, order);
    case "manufacture":
      return manufacture(ctx, order);
    case "monetize":
      return monetize(ctx, order);
    case "spin_up":
      return spinUp(ctx, order);
    case "execute":
      return execute(ctx, order);
    case "set_research":
      return setResearch(ctx, order);
    case "scratchpad":
      return scratchpad(ctx, order);
  }
}
