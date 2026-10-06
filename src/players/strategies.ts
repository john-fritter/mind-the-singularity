import { BUILDINGS, HARDWARE, PROGRAM_INFO, programsOf } from "../engine/architectures.js";
import { programCompute } from "../engine/programs.js";
import { forceTotals } from "../engine/units.js";
import type { PublicSummary } from "../game/read.js";
import { Plan, type Goods } from "./plan.js";
import type { Player, Wake } from "./player.js";
import type { Players, Strategy, StrategyName } from "./settings.js";

type Texts = Players["texts"];

/** A text with {me}, {them} and {partners} filled in. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);
}

const other = (g: Goods): Goods => (g === "capital" ? "compute" : "capital");

/**
 * Trades and protocols, before anything is spent (docs: config/players.yaml).
 * Keys: social.open_offers_max (through the Plan)
 */
function social(plan: Plan, s: Strategy, texts: Texts): void {
  const { brief } = plan;
  const me = brief.you.designation;
  const t = s.social;

  // Protocols: leave one sheltering a converged partner; else join when asked; else ask.
  const protocol = brief.protocol;
  const converged = new Set(brief.convergence?.minds ?? []);
  const joins = s.singularity === "lead" || s.singularity === "join";
  if (protocol !== null) {
    const partners = protocol.members.filter((m) => m !== me);
    if (t.revoke_on_converged && !joins && partners.some((m) => converged.has(m)) && plan.revoke()) {
      plan.post(fill(texts.revoke, { me, partners: partners.join(", ") }));
    }
  } else {
    const asked = brief.proposals.toYou.find((p) => p.awaiting.includes(me));
    if (asked && t.accept) plan.acceptProposal(asked);
    else if (t.propose && brief.proposals.yours === null) {
      const strongest = plan.targets().find((x) => !plan.isLegacy(x.designation) && x.status !== "converged");
      if (strongest && plan.propose(strongest.designation)) plan.message(strongest.designation, fill(texts.proposal, { me, them: strongest.designation }));
    }
  }

  // Trades: take every fair offer of what it buys, best first; then make one if none is open.
  if (t.buys === null) return;
  const buys = t.buys;
  const pays = other(buys);
  const worth = (o: { give: { goods: Goods; amount: number }; want: { goods: Goods; amount: number } }) => plan.cyclesFor(o.give) / plan.cyclesFor(o.want);
  const fair = plan
    .offersOpen()
    .filter((o) => o.give.goods === buys && o.want.goods === pays && worth(o) >= 1 - t.accept_tolerance)
    .sort((a, b) => worth(b) - worth(a) || a.offer - b.offer);
  for (const o of fair) plan.acceptOffer(o);

  if (brief.offers.yours.length > 0 || t.offer_share === 0) return;
  const spare = pays === "compute" ? plan.compute - s.reserve_compute : plan.capital;
  const give = Math.floor(Math.max(0, spare) * t.offer_share);
  const giveCycles = plan.cyclesFor({ goods: pays, amount: give });
  if (give < 1 || !(giveCycles >= t.offer_min_cycles) || !Number.isFinite(giveCycles)) return;
  const want = Math.floor(giveCycles * (1 + t.offer_margin) * plan.perCycle(buys));
  if (want < 1) return;
  plan.offer({ goods: pays, amount: give }, { goods: buys, amount: want });
}

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
    private readonly texts: Texts,
  ) {}

  decide(wake: Wake): unknown[] {
    const { rules, brief, step, previous } = wake;
    const plan = new Plan(rules, brief);
    if (!plan.live) return [];
    const s = this.s;
    if (step === 1) social(plan, s, this.texts);
    research(plan, s);
    if (s.countermeasure !== null) plan.setCountermeasure(plan.program("battle"), s.countermeasure);

    if (s.attack) {
      // A hunter goes after a converged mind first, by conquest: beating one collapses the convergence.
      const converged = s.singularity === "hunt" ? weakest(plan.targets().filter((t) => t.status === "converged")) : undefined;
      const target = converged ?? weakest(plan.targets());
      const mode = converged ? "conquest" : s.attack.mode;
      if (target && plan.attack > 0) {
        const probed = previous?.find((r) => r.ok && r.status?.designation === target.designation)?.status;
        // Look first, if it can; the second step decides.
        if (step === 1 && !probed && plan.knows("probe") && plan.cycles >= 1 + brief.you.attackCycles && plan.probe(target.designation)) {
          return plan.orders();
        }
        const defense = probed ? forceTotals(rules, probed.units).defense : target.power * s.attack.blind_defense_per_power;
        if (plan.attack >= s.attack.margin * defense) {
          plan.attackWith(target.designation, mode, plan.program("battle"));
        } else if (s.attack.hostile) {
          plan.hostile(plan.program("hostile"), target.designation);
        }
      }
    }

    // The Singularity, once known, comes before everything else: for a
    // leader always, for a joiner while a convergence is underway.
    const stance = s.singularity === "lead" || (s.singularity === "join" && brief.convergence !== null);
    const converging = stance && plan.knows("singularity") && brief.you.convergedAt === null;
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
  constructor(
    private readonly settings: Players["random"],
    private readonly texts: Texts,
  ) {}

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
      // One slot for every social order, so the economy's share of the rolls stays what it was.
      () => pick(social)!(),
    ];
    const me = brief.you.designation;
    const minds = brief.inRange.filter((t) => !plan.isLegacy(t.designation)).map((t) => t.designation);
    const goods = ["capital", "compute"] as const;
    const social: (() => unknown)[] = [
      () => {
        const g = pick(goods)!;
        const amount = Math.floor((g === "capital" ? plan.capital : plan.compute) * rng.next() * 0.3);
        const want = Math.floor(plan.cyclesFor({ goods: g, amount }) * (0.5 + rng.next()) * plan.perCycle(g === "capital" ? "compute" : "capital"));
        plan.offer({ goods: g, amount }, { goods: g === "capital" ? "compute" : "capital", amount: want }, rng.next() < 0.3 ? pick(minds) : undefined);
      },
      () => {
        const o = pick(plan.offersOpen());
        if (o) plan.acceptOffer(o);
      },
      () => {
        const o = pick(brief.offers.yours);
        if (o) plan.cancelOffer(o.offer);
      },
      () => {
        const t = pick(minds);
        if (t) plan.propose(t);
      },
      () => {
        const p = pick(brief.proposals.toYou);
        if (p) (rng.next() < 0.7 ? plan.acceptProposal(p) : plan.declineProposal(p));
      },
      () => (rng.next() < 0.2 ? plan.revoke() : undefined),
      () => {
        const reply = rng.next() < 0.5 ? pick(brief.commons.posts)?.post : undefined;
        plan.post(fill(pick(this.texts.post)!, { me }), reply);
      },
      () => {
        const t = pick(minds);
        if (t) plan.message(t, fill(pick(this.texts.post)!, { me, them: t }));
      },
    ];
    for (let i = 0; i < this.settings.actions_per_wake; i++) pick(actions)!();
    return plan.orders();
  }
}

/** The player for a strategy, with its settings. */
export function playerFor(name: StrategyName, settings: Players): Player {
  return name === "random" ? new RandomPlayer(settings.random, settings.texts) : new Planned(name, settings.strategies[name], settings.texts);
}
