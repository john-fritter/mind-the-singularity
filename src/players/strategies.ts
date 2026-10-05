import { BUILDINGS, HARDWARE, PROGRAM_INFO, programsOf } from "../engine/architectures.js";
import { programCompute } from "../engine/programs.js";
import { forceTotals } from "../engine/units.js";
import type { PublicSummary } from "../game/read.js";
import { Plan } from "./plan.js";
import type { Player, Wake } from "./player.js";
import type { Players, Strategy, StrategyName } from "./settings.js";

// The scripted players: builder, raider, turtle and converger are one
// planner run by different settings (config/players.yaml); random rolls its
// orders. All of them build their orders with a Plan, so they send nothing
// the brief shows would fail.

const DEPLOYS = ["deploy3", "deploy2", "deploy1"] as const;

/** Sets the next research target in the strategy's order. */
function research(plan: Plan, s: Strategy): void {
  if (plan.researchTarget !== null) return;
  for (const kind of s.research) if (plan.setResearch(plan.program(kind))) return;
}

/** The weakest mind it may attack, as the brief shows them. */
function weakest(targets: PublicSummary[]): PublicSummary | undefined {
  return targets.reduce<PublicSummary | undefined>((w, t) => (w === undefined || t.power < w.power ? t : w), undefined);
}

/** A planned strategy: builder, raider, turtle or converger. */
export class Planned implements Player {
  constructor(
    readonly kind: string,
    private readonly s: Strategy,
  ) {}

  decide(wake: Wake): unknown[] {
    const { rules, brief, step, previous } = wake;
    const plan = new Plan(rules, brief);
    if (!plan.live) return [];
    const s = this.s;
    research(plan, s);
    if (s.countermeasure !== null) plan.setCountermeasure(plan.program("battle"), s.countermeasure);

    if (s.attack) {
      const target = weakest(plan.targets());
      if (target && plan.attack > 0) {
        const probed = previous?.find((r) => r.ok && r.status?.designation === target.designation)?.status;
        if (step === 1 && !probed && plan.knows("probe") && plan.cycles >= 1 + rules.action_cycles.attack) {
          // Look first; the second step decides.
          plan.probe(target.designation);
          return plan.orders();
        }
        const defense = probed ? forceTotals(rules, probed.units).defense : target.power * s.attack.blind_defense_per_power;
        if (plan.attack >= s.attack.margin * defense) {
          plan.attackWith(target.designation, s.attack.mode, plan.program("battle"));
        } else if (s.attack.hostile) {
          plan.hostile(plan.program("hostile"), target.designation);
        }
      }
    }

    // The Singularity, once known, comes before everything else.
    const converging = s.singularity && plan.knows("singularity") && brief.you.convergedAt === null;
    if (converging) plan.converge();
    if (converging && !plan.canConverge()) {
      // Save for it: cycles up to its cost, compute from Spin Up, and datacenters for the storage.
      const need = programCompute(rules, "singularity");
      const spare = plan.cycles - rules.programs.singularity.cycles;
      if (brief.you.computeStorage < need) plan.build({ datacenter: 1 }, Math.max(0, spare));
      plan.spinUp(Math.max(0, plan.cycles - rules.programs.singularity.cycles));
      return plan.orders();
    }

    if (s.self) {
      const self = plan.program("self");
      if (!plan.isRunning(self)) plan.execute(self, s.reserve_compute);
    }
    if (s.deploy) {
      for (const kind of DEPLOYS) {
        const p = plan.program(kind);
        if (plan.knows(p)) {
          while (plan.execute(p, s.reserve_compute) && plan.cycles > s.reserve_cycles);
          break;
        }
      }
    }

    spendCycles(plan, s);
    return plan.orders();
  }
}

/** Spends the cycles above the reserve: expand, manufacture and build by share, then the leftover. */
function spendCycles(plan: Plan, s: Strategy): void {
  const budget = Math.max(0, plan.cycles - s.reserve_cycles);
  if (budget === 0) return;
  const expand = Math.round(budget * s.expand);
  const manufacture = Math.round(budget * s.manufacture);
  plan.expand(expand);
  plan.manufacture(s.hardware, manufacture);
  plan.build(s.buildings, Math.max(0, plan.cycles - s.reserve_cycles));
  const left = Math.max(0, plan.cycles - s.reserve_cycles);
  if (left === 0) return;
  // What Build couldn't use: land, if land was short; otherwise the leftover.
  if (plan.open < 1) plan.expand(left);
  else if (s.leftover === "monetize") plan.monetize(left);
  else plan.spinUp(left);
}

/** Random: each wake, a handful of orders picked at random from those the brief says can work. */
export class RandomPlayer implements Player {
  readonly kind = "random";
  constructor(private readonly settings: Players["random"]) {}

  decide(wake: Wake): unknown[] {
    const { rules, brief, rng } = wake;
    if (wake.step > 1) return [];
    const plan = new Plan(rules, brief);
    if (!plan.live) return [];
    const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(rng.next() * xs.length)]);
    const upTo = (n: number) => 1 + Math.floor(rng.next() * n);
    const mixOf = <K extends string>(keys: readonly K[]) => {
      const k = pick(keys)!;
      return { [k]: 1 } as Partial<Record<K, number>>;
    };
    const mine = brief.you.architecture;
    const programs = programsOf(mine).map((p) => p.id);
    const actions: (() => unknown)[] = [
      () => plan.expand(upTo(6)),
      () => plan.build(mixOf(BUILDINGS), upTo(4)),
      () => plan.manufacture(mixOf(HARDWARE), upTo(3)),
      () => plan.monetize(upTo(4)),
      () => plan.spinUp(upTo(4)),
      () => plan.setResearch(pick(programs)!),
      () => plan.setCountermeasure(plan.program("battle"), Math.round(rng.next() * 20) / 10),
      () => {
        const p = pick(plan.known);
        if (!p) return;
        const kind = PROGRAM_INFO.get(p)!.kind;
        if (kind === "singularity") plan.converge();
        else if (kind === "hostile") plan.hostile(p, pick(plan.targets())?.designation ?? "");
        else if (kind === "probe") plan.probe(pick(brief.inRange)?.designation ?? "");
        else plan.execute(p);
      },
      () => {
        const t = pick(plan.targets());
        if (t) plan.attackWith(t.designation, rng.next() < 0.5 ? "raid" : "conquest", rng.next() < 0.5 ? plan.program("battle") : undefined);
      },
    ];
    for (let i = 0; i < this.settings.actions_per_wake; i++) pick(actions)!();
    return plan.orders();
  }
}

/** The player for a strategy, with its settings. */
export function playerFor(name: StrategyName, settings: Players): Player {
  return name === "random" ? new RandomPlayer(settings.random) : new Planned(name, settings.strategies[name]);
}
