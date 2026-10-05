import { HARDWARE, PROGRAM_INFO, programsOf, type Building, type Hardware, type Program, type Tier, type Unit } from "../engine/architectures.js";
import {
  buildingCost,
  buildingUpkeep,
  buildRate,
  capitalIncome,
  computeIncome,
  computeStorage,
  expansionYield,
  hardwareHousing,
  manufactureCapacity,
  userCap,
  userChange,
} from "../engine/economy.js";
import { deployCount, programCompute, scaledShare } from "../engine/programs.js";
import type { Rules } from "../engine/rules.js";
import { forceTotals } from "../engine/units.js";
import type { Brief, PublicSummary } from "../game/read.js";

// A wake's orders, built against what the brief says. Every order is added
// only if the brief shows it can work, so a scripted player never sends an
// order it could have known would fail. The plan keeps a running estimate
// of the domain as its orders spend: exact for cycles, land and what's
// bought, and a lower bound for capital, compute and users (each cycle's
// income and upkeep as the engine pays them, but no program bonuses and no
// user growth), so the estimate never promises what the engine won't have.
//
// It uses the engine's pure formulas: the rules text documents them, so an
// agent could work them out too.

/** A building or unit mix: shares adding up to 1. */
export type Mix<K extends string> = Partial<Record<K, number>>;

/** Splits `total` by `mix`, largest remainder first, ties to the earlier key. */
export function apportion<K extends string>(mix: Mix<K>, total: number): Map<K, number> {
  const keys = (Object.keys(mix) as K[]).filter((k) => (mix[k] ?? 0) > 0);
  const exact = keys.map((k) => (mix[k] ?? 0) * total);
  const take = exact.map(Math.floor);
  let left = total - take.reduce((a, b) => a + b, 0);
  const order = keys.map((_, i) => i).sort((a, b) => exact[b]! - take[b]! - (exact[a]! - take[a]!) || a - b);
  for (const i of order) {
    if (left <= 0) break;
    take[i]!++;
    left--;
  }
  return new Map(keys.map((k, i) => [k, take[i]!]));
}

export class Plan {
  /** Orders that cost no cycles, sent first so nothing spent before them can change what they need. */
  private readonly free: unknown[] = [];
  private readonly spending: unknown[] = [];
  /** Nothing may follow the Singularity: it can end the epoch. */
  private closed = false;

  cycles: number;
  capital: number;
  compute: number;
  users: number;
  territory: number;
  buildings: Record<Building, number>;
  units: Partial<Record<Unit, number>>;
  readonly known: Program[];
  readonly running = new Set<Program>();
  researchTarget: Program | null;
  /** Cycles this plan has spent so far. */
  spent = 0;

  constructor(
    readonly rules: Rules,
    readonly brief: Brief,
  ) {
    const y = brief.you;
    this.cycles = y.cycles;
    this.capital = y.capital;
    this.compute = y.compute;
    this.users = y.users;
    this.territory = y.territory;
    this.buildings = { ...y.buildings };
    this.units = { ...y.units };
    this.known = [...y.known];
    for (const r of y.running) this.running.add(r.program);
    this.researchTarget = y.research?.program ?? null;
  }

  get now(): number {
    return this.brief.now;
  }

  /** The orders, free ones first. */
  orders(): unknown[] {
    return [...this.free, ...this.spending];
  }

  get open(): number {
    return this.territory - Object.values(this.buildings).reduce((a, b) => a + b, 0);
  }

  get hardware(): number {
    return HARDWARE.reduce((n, h) => n + (this.units[h] ?? 0), 0);
  }

  get attack(): number {
    return forceTotals(this.rules, this.units).attack;
  }

  /** Whether the mind can act at all: alive, the epoch going. */
  get live(): boolean {
    return this.brief.epoch.ended === null && this.brief.you.deletedAt === null;
  }

  /** The program of a kind for this mind's architecture. */
  program(kind: "probe" | "self" | "battle" | "hostile" | "singularity" | "deploy1" | "deploy2" | "deploy3"): Program {
    const all = programsOf(this.brief.you.architecture);
    if (kind.startsWith("deploy")) return all.find((p) => p.kind === "deploy" && p.deployTier === Number(kind.slice(6)))!.id;
    return all.find((p) => p.kind === kind)!.id;
  }

  knows(program: Program): boolean {
    return this.known.includes(program);
  }

  /** One cycle's economy, as a lower bound: income only where upkeep or shrinking outweighs it. */
  private passCycles(k: number): void {
    const r = this.rules;
    for (let i = 0; i < k; i++) {
      this.cycles--;
      this.spent++;
      // As the engine runs a cycle: income, users, upkeep. Program bonuses
      // are left out, and Blight may stall growth, so users don't grow here.
      const force = forceTotals(r, this.units);
      const capital = this.capital + Math.floor(capitalIncome(r, this.users, this.buildings.city));
      const compute = Math.min(computeStorage(r, this.buildings.datacenter), this.compute + Math.floor(computeIncome(r, this.buildings.datacenter)));
      const change = Math.floor(userChange(r, this.users, userCap(r, this.buildings.city, this.territory)));
      this.users = Math.max(0, this.users + Math.min(0, change));
      const capitalUpkeep = Math.ceil(buildingUpkeep(r, this.buildings) + force.capitalUpkeep);
      this.capital = capital >= capitalUpkeep ? capital - capitalUpkeep : 0;
      const computeUpkeep = Math.ceil(force.computeUpkeep);
      this.compute = compute >= computeUpkeep ? compute - computeUpkeep : 0;
    }
  }

  private canSpend(cycles: number): boolean {
    return !this.closed && this.live && this.cycles >= cycles;
  }

  // ── Free orders ───────────────────────────────────────────────────────

  /** Sets the research target, if the program can be researched. */
  setResearch(program: Program): boolean {
    if (!this.live || this.knows(program) || this.researchTarget === program) return false;
    if (!programsOf(this.brief.you.architecture).some((p) => p.id === program)) return false;
    if (program === "singularity" && !programsOf(this.brief.you.architecture).every((p) => p.kind === "singularity" || this.knows(p.id))) return false;
    this.free.push({ do: "set_research", program });
    this.researchTarget = program;
    return true;
  }

  setCountermeasure(program: Program, above: number): boolean {
    if (!this.live || !this.knows(program) || PROGRAM_INFO.get(program)!.kind !== "battle") return false;
    const cm = this.brief.you.countermeasure;
    if (cm && cm.program === program && cm.above === above) return false;
    this.free.push({ do: "set_countermeasure", program, above });
    return true;
  }

  scratchpad(text: string): boolean {
    if (!this.live || text.length > this.rules.flavor.scratchpad) return false;
    this.free.push({ do: "scratchpad", text });
    return true;
  }

  // ── Orders aimed at another mind ──────────────────────────────────────

  /**
   * Minds in range, as the brief has them. Only good before any cycle is
   * spent: a cycle can change this mind's power (research may finish), and
   * with it who is in range.
   */
  targets(): PublicSummary[] {
    return this.spent === 0 ? this.brief.inRange : [];
  }

  attackWith(target: string, mode: "conquest" | "raid", program?: Program): boolean {
    const cost = this.rules.action_cycles.attack;
    if (!this.canSpend(cost) || !this.targets().some((t) => t.designation === target) || this.attack <= 0) return false;
    if (this.brief.now < this.brief.you.bootPeriodEndsAt) return false;
    const order: Record<string, unknown> = { do: "attack", target, mode };
    if (program !== undefined && this.knows(program) && PROGRAM_INFO.get(program)!.kind === "battle" && this.compute >= programCompute(this.rules, program)) {
      order.program = program;
      this.compute -= programCompute(this.rules, program);
    }
    this.spending.push(order);
    // A fight costs units; assume none, which only overstates upkeep.
    this.passCycles(cost);
    return true;
  }

  /** A hostile program on a mind in range. */
  hostile(program: Program, target: string): boolean {
    const cost = this.rules.action_cycles.execute;
    if (!this.canSpend(cost) || !this.knows(program) || PROGRAM_INFO.get(program)!.kind !== "hostile") return false;
    if (!this.targets().some((t) => t.designation === target) || this.brief.now < this.brief.you.bootPeriodEndsAt) return false;
    const compute = programCompute(this.rules, program);
    if (this.compute < compute) return false;
    this.compute -= compute;
    this.spending.push({ do: "execute", program, target });
    this.passCycles(cost);
    return true;
  }

  /** Probe: any live mind, shields or not. */
  probe(target: string): boolean {
    const cost = this.rules.action_cycles.execute;
    const compute = programCompute(this.rules, "probe");
    if (!this.canSpend(cost) || !this.knows("probe") || this.compute < compute) return false;
    if (target === this.brief.you.designation) return false;
    this.compute -= compute;
    this.spending.push({ do: "execute", program: "probe", target });
    this.passCycles(cost);
    return true;
  }

  // ── Orders on its own domain ──────────────────────────────────────────

  expand(cycles: number): number {
    const cost = this.rules.action_cycles.expand;
    const k = Math.min(Math.floor(cycles / cost), Math.floor(this.cycles / cost));
    if (k <= 0 || !this.canSpend(cost)) return 0;
    for (let i = 0; i < k; i++) {
      this.territory += expansionYield(this.rules, this.territory);
      this.passCycles(cost);
    }
    this.spending.push({ do: "expand", cycles: k * cost });
    return k * cost;
  }

  /** Up to `batches` Build batches in the mix; stops at the first that can't place anything. Returns cycles spent. */
  build(mix: Mix<Building>, batches: number): number {
    const cost = this.rules.action_cycles.build;
    let spent = 0;
    for (let i = 0; i < batches && this.canSpend(cost); i++) {
      const size = Math.min(buildRate(this.rules, this.territory), this.open);
      if (size <= 0) break;
      const want = new Map<Building, number>();
      let capital = this.capital;
      for (const [b, k] of apportion(mix, size)) {
        const price = buildingCost(this.rules, b, this.territory);
        const n = Math.min(k, Math.floor(capital / price));
        if (n > 0) want.set(b, n);
        capital -= n * price;
      }
      if (want.size === 0) break;
      this.capital = capital;
      for (const [b, n] of want) this.buildings[b] += n;
      this.spending.push({ do: "build", buildings: Object.fromEntries(want) });
      this.passCycles(cost);
      spent += cost;
    }
    return spent;
  }

  /** Up to `batches` Manufacture batches in the mix. Returns cycles spent. */
  manufacture(mix: Mix<Hardware>, batches: number): number {
    const cost = this.rules.action_cycles.manufacture;
    let spent = 0;
    for (let i = 0; i < batches && this.canSpend(cost); i++) {
      const room = hardwareHousing(this.rules, this.buildings.factory) - this.hardware;
      const size = Math.min(manufactureCapacity(this.rules, this.buildings.factory), room);
      if (size <= 0) break;
      const want = new Map<Hardware, number>();
      let { capital, users } = this;
      for (const [h, k] of apportion(mix, size)) {
        const s = this.rules.hardware[h];
        const n = Math.min(k, Math.floor(capital / s.capital), s.users > 0 ? Math.floor(users / s.users) : k);
        if (n > 0) want.set(h, n);
        capital -= n * s.capital;
        users -= n * s.users;
      }
      if (want.size === 0) break;
      this.capital = capital;
      this.users = users;
      for (const [h, n] of want) this.units[h] = (this.units[h] ?? 0) + n;
      this.spending.push({ do: "manufacture", units: Object.fromEntries(want) });
      this.passCycles(cost);
      spent += cost;
    }
    return spent;
  }

  monetize(cycles: number): number {
    return this.repeatable("monetize", this.rules.action_cycles.monetize, cycles);
  }

  spinUp(cycles: number): number {
    return this.repeatable("spin_up", this.rules.action_cycles.spin_up, cycles);
  }

  private repeatable(kind: string, cost: number, cycles: number): number {
    const k = Math.min(Math.floor(cycles / cost), Math.floor(this.cycles / cost));
    if (k <= 0 || !this.canSpend(cost)) return 0;
    this.passCycles(k * cost);
    this.spending.push({ do: kind, cycles: k * cost });
    return k * cost;
  }

  /** Whether a self program is running now, by the brief or this plan. */
  isRunning(program: Program): boolean {
    return this.running.has(program);
  }

  /** Runs a self or deploy program, keeping `reserve` compute back. */
  execute(program: Program, reserve = 0): boolean {
    const info = PROGRAM_INFO.get(program)!;
    if (info.kind !== "self" && info.kind !== "deploy") return false;
    const cost = this.rules.action_cycles.execute;
    const compute = programCompute(this.rules, program);
    if (!this.canSpend(cost) || !this.knows(program) || this.compute < compute + reserve) return false;
    this.compute -= compute;
    this.spending.push({ do: "execute", program });
    if (info.kind === "deploy") {
      // Assume it arrives, which only overstates upkeep; a crash brings nothing.
      const unit = program as Unit;
      this.units[unit] = (this.units[unit] ?? 0) + deployCount(this.rules, info.deployTier as Tier, this.known.length);
    } else if (program === "assimilation") {
      // Research may finish mid-wake and raise capability; assume the most.
      const share = scaledShare(this.rules, this.rules.architectures.assimilator.programs.assimilation.user_share, programsOf(this.brief.you.architecture).length);
      this.users -= Math.ceil(this.users * share);
    } else {
      this.running.add(program);
    }
    this.passCycles(cost);
    return true;
  }

  /** Whether the Singularity can be run now, as far as the brief shows. */
  canConverge(): boolean {
    const r = this.rules.programs.singularity;
    const c = this.brief.convergence;
    if (!this.canSpend(r.cycles) || !this.knows("singularity") || this.brief.you.convergedAt !== null) return false;
    if (c && c.nextJoinAt !== null && this.now < c.nextJoinAt) return false;
    return this.compute >= programCompute(this.rules, "singularity");
  }

  converge(): boolean {
    if (!this.canConverge()) return false;
    this.compute -= programCompute(this.rules, "singularity");
    this.spending.push({ do: "execute", program: "singularity" });
    this.passCycles(this.rules.programs.singularity.cycles);
    this.closed = true;
    return true;
  }
}
