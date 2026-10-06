import { BUILDINGS, HARDWARE, PROGRAM_INFO, type Program } from "./architectures.js";
import { attackCycles, attackerStrength, battleOutcome, conquestSectors, defenderStrength, raidSpoils, unitsLost } from "./combat.js";
import { fail, n, outOfCycles, spend, type OrderContext, type OrderResult } from "./context.js";
import { collapse } from "./convergence.js";
import { addCompute } from "./cycle.js";
import { DAY_MS, HOUR_MS, syncCycles } from "./cycles.js";
import { deleteMind } from "./deletion.js";
import { capability, isRunning, totalBuildings, unitCounts } from "./domain.js";
import { computeStorage, hardwareHousing, userCap } from "./economy.js";
import { programName, resolveDomain, resolveProgram } from "./names.js";
import type { Order } from "./orders.js";
import { firewallBlockChance, programCompute, programCrashChance, scaledEffect, scaledShare } from "./programs.js";
import { hostileCapReached, leaveSafeMode, noteAggression, noteHit, noteHostile, shieldedBecause } from "./protection.js";
import { describe, emit, type BattleLine, type BattleReport, type HostileEffect, type ProgramUse } from "./record.js";
import type { Rng } from "./rng.js";
import type { Rules } from "./rules.js";
import type { Domain } from "./state.js";
import { domainStatus } from "./status.js";
import { withdrawOffers } from "./trades.js";
import { forceTotals, unitStats } from "./units.js";

// Orders aimed at another mind: attacks (conquest and raid) with their
// battle programs and the defender's countermeasure, hostile programs and
// Probe. Every function here mutates the world it's given.

/** The mind an order names, or why it can't be targeted. */
function findTarget(ctx: OrderContext, text: string): Domain | string {
  const target = resolveDomain(ctx.world, text);
  if (!target) return `No mind called ${text}.`;
  if (target.id === ctx.domain.id) return "You can't target yourself.";
  return target;
}

const NON_CORE = BUILDINGS.filter((b) => b !== "core");
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Takes `k` away from `have`, spread in proportion (largest remainder, ties
 * to the earlier entry). Returns how many came from each.
 */
function spread(have: readonly number[], k: number): number[] {
  const total = sum(have);
  if (k <= 0 || total === 0) return have.map(() => 0);
  const exact = have.map((h) => (h * k) / total);
  const take = exact.map(Math.floor);
  let left = k - sum(take);
  const order = have.map((_, i) => i).sort((a, b) => exact[b]! - take[b]! - (exact[a]! - take[a]!) || a - b);
  for (const i of order) {
    if (left === 0) break;
    if (take[i]! < have[i]!) {
      take[i]!++;
      left--;
    }
  }
  return take;
}

/**
 * Destroys up to `count` buildings, cores excepted, spread across types in
 * proportion to how many of each there are. What the lost datacenters and
 * factories held goes with them: compute past storage is lost, and hardware
 * past housing is abandoned in proportion. Returns the buildings destroyed.
 * Mutates the domain. Keys: as computeStorage, hardwareHousing
 */
export function destroyBuildings(rules: Rules, d: Domain, count: number): number {
  const have = NON_CORE.map((b) => d.buildings[b]);
  const k = Math.min(Math.max(0, count), sum(have));
  const take = spread(have, k);
  NON_CORE.forEach((b, i) => (d.buildings[b] -= take[i]!));
  d.compute = Math.min(d.compute, computeStorage(rules, d.buildings.datacenter));
  const hardware = HARDWARE.map((h) => d.units[h] ?? 0);
  const over = sum(hardware) - hardwareHousing(rules, d.buildings.factory);
  const abandoned = spread(hardware, over);
  HARDWARE.forEach((h, i) => {
    if (abandoned[i]! > 0) d.units[h] = hardware[i]! - abandoned[i]!;
  });
  return k;
}

// ── Battle programs ─────────────────────────────────────────────────────

/**
 * Pushes a battle program's strength multipliers onto its caster's list and
 * the enemy's. Adversarial Input draws once for its miss.
 * Keys: architectures.accelerant.programs.arc_strike.strength_bonus,
 * architectures.symbiote.programs.entanglement.enemy_strength_reduction,
 * architectures.oracle.programs.adversarial_input.*
 */
function strengthModifiers(rules: Rules, ran: Program | null, caster: Domain, own: number[], enemy: number[], rng: Rng): void {
  const cap = capability(caster);
  const a = rules.architectures;
  if (ran === "arc_strike") own.push(1 + scaledEffect(rules, a.accelerant.programs.arc_strike.strength_bonus, cap));
  if (ran === "entanglement") enemy.push(1 - scaledShare(rules, a.symbiote.programs.entanglement.enemy_strength_reduction, cap));
  if (ran === "adversarial_input") {
    const p = a.oracle.programs.adversarial_input;
    if (rng.next() < scaledShare(rules, p.miss_chance, cap)) enemy.push(p.miss_strength_factor);
  }
}

/**
 * A side's losses multiplier: Restoration if it ran, False Signature if
 * running. Keys: architectures.steward.programs.restoration.loss_reduction,
 * architectures.oracle.programs.false_signature.decoy_loss_share
 */
function lossFactor(rules: Rules, d: Domain, ran: Program | null, now: number): number {
  const cap = capability(d);
  let f = 1;
  if (ran === "restoration") f *= 1 - scaledShare(rules, rules.architectures.steward.programs.restoration.loss_reduction, cap);
  if (isRunning(d, "false_signature", now)) {
    f *= 1 - scaledShare(rules, rules.architectures.oracle.programs.false_signature.decoy_loss_share, cap);
  }
  return f;
}

/** Removes a side's losses. Returns units lost and their attack plus defense. Keys: as unitsLost */
function takeLosses(rules: Rules, d: Domain, share: number): { lost: number; points: number } {
  let lost = 0;
  let points = 0;
  for (const [unit, count] of unitCounts(d)) {
    const s = unitStats(rules, unit);
    const k = Math.min(count, unitsLost(rules, count, share, s.ranged));
    d.units[unit] = count - k;
    lost += k;
    points += k * (s.attack + s.defense);
  }
  return { lost, points };
}

/**
 * Recycle Casualties: a share of the destroyed units' attack plus defense
 * comes back as Husks. Returns how many. Keys:
 * architectures.assimilator.programs.recycle_casualties.recycled_share
 */
function recycle(rules: Rules, d: Domain, ran: Program | null, points: number): number {
  if (ran !== "recycle_casualties") return 0;
  const share = scaledShare(rules, rules.architectures.assimilator.programs.recycle_casualties.recycled_share, capability(d));
  const husk = unitStats(rules, "husks");
  const k = Math.floor((points * share) / (husk.attack + husk.defense));
  if (k > 0) d.units.husks = (d.units.husks ?? 0) + k;
  return k;
}

/** Spends a battle program's compute and draws for a crash. */
function runBattleProgram(rules: Rules, d: Domain, program: Program, rng: Rng): ProgramUse {
  const compute = programCompute(rules, program);
  if (d.compute < compute) return { program, outcome: "no_compute" };
  d.compute -= compute;
  return { program, outcome: rng.next() < programCrashChance(rules, program, capability(d)) ? "crashed" : "ran" };
}

// ── Attack ──────────────────────────────────────────────────────────────

/**
 * Attack: the whole force against the defender's whole force, in one round.
 * Draws, in this order, so a battle replays from its seed: the attacker's
 * program crash, the countermeasure's crash, the random factor, then each
 * Adversarial Input miss (attacker's first).
 * Keys: action_cycles.attack, combat.*, as the helpers above
 */
export function attack(ctx: OrderContext, order: Extract<Order, { do: "attack" }>): OrderResult {
  const { rules, world, domain: me, now, rng } = ctx;
  const target = findTarget(ctx, order.target);
  if (typeof target === "string") return fail(order, target);
  const shield = shieldedBecause(rules, me, target, now);
  if (shield) return fail(order, shield);
  me.attacksMade = me.attacksMade.filter((t) => t > now - DAY_MS);
  const cost = attackCycles(rules, me.attacksMade.length);
  if (me.cycles < cost) return outOfCycles(order, cost, me.cycles);
  const mine = forceTotals(rules, me.units);
  if (mine.attack <= 0) return fail(order, "You have no units that can attack.");

  let program: Program | null = null;
  if (order.program !== undefined) {
    const p = resolveProgram(rules, order.program);
    if (!p) return fail(order, `No such program: ${order.program}.`);
    const name = programName(rules, p);
    if (!me.known.includes(p)) return fail(order, `You don't know ${name}.`);
    if (PROGRAM_INFO.get(p)!.kind !== "battle") return fail(order, `${name} isn't a battle program.`);
    const compute = programCompute(rules, p);
    if (me.compute < compute) return fail(order, `${name} needs ${n(compute)} compute; you have ${n(me.compute)}.`);
    program = p;
  }

  const theirs = forceTotals(rules, target.units);
  const attackerProgram = program ? runBattleProgram(rules, me, program, rng) : null;
  const cm = target.countermeasure;
  const countermeasure = cm && mine.attack > cm.above * theirs.defense ? runBattleProgram(rules, target, cm.program, rng) : null;
  const draw = rng.next();
  const aRan = attackerProgram?.outcome === "ran" ? attackerProgram.program : null;
  const dRan = countermeasure?.outcome === "ran" ? countermeasure.program : null;

  const a = rules.architectures;
  const aMods: number[] = [];
  const dMods: number[] = [];
  if (isRunning(me, "overclock", now)) aMods.push(1 + scaledEffect(rules, a.accelerant.programs.overclock.attack_bonus, capability(me)));
  if (isRunning(target, "hardening", now)) dMods.push(1 + scaledEffect(rules, a.steward.programs.hardening.defense_bonus, capability(target)));
  strengthModifiers(rules, aRan, me, aMods, dMods, rng);
  strengthModifiers(rules, dRan, target, dMods, aMods, rng);

  const aStrength = attackerStrength(rules, {
    attack: mine.attack,
    architecture: me.architecture,
    defenderArchitecture: target.architecture,
    modifiers: aMods,
    draw,
  });
  const dStrength = defenderStrength(rules, { defense: theirs.defense, cores: target.buildings.core, modifiers: dMods });
  const outcome = battleOutcome(rules, aStrength, dStrength);

  const aLoss = takeLosses(rules, me, outcome.attackerLoss * lossFactor(rules, me, aRan, now));
  const dLoss = takeLosses(rules, target, outcome.defenderLoss * lossFactor(rules, target, dRan, now));
  const attackerRecycled = recycle(rules, me, aRan, aLoss.points);
  const defenderRecycled = recycle(rules, target, dRan, dLoss.points);

  const report: BattleReport = {
    attacker: me.id,
    defender: target.id,
    attackerName: me.designation,
    defenderName: target.designation,
    mode: order.mode,
    attackerWon: outcome.attackerWins,
    sectors: 0,
    cores: 0,
    capital: 0,
    users: 0,
    buildings: 0,
    attackerStrength: aStrength,
    defenderStrength: dStrength,
    attackerProgram,
    countermeasure,
    attackerLost: aLoss.lost,
    defenderLost: dLoss.lost,
    attackerRecycled,
    defenderRecycled,
  };

  // Escrow is no vault: what a beaten mind has on offer comes back in reach.
  if (outcome.attackerWins) withdrawOffers(rules, world, target, now, ctx.events);
  if (outcome.attackerWins && order.mode === "conquest") {
    if (outcome.lopsided) {
      report.cores = Math.min(rules.combat.lopsided_cores, target.buildings.core);
      target.buildings.core -= report.cores;
    }
    // The land arrives open: the defender's buildings on it go in
    // proportion, and more if that's what it takes to fit what's left.
    const sectors = Math.min(conquestSectors(rules, target.territory), target.territory - target.buildings.core);
    const nonCore = totalBuildings(target) - target.buildings.core;
    const proportional = target.territory > 0 ? Math.round((nonCore * sectors) / target.territory) : 0;
    const toFit = totalBuildings(target) - (target.territory - sectors);
    destroyBuildings(rules, target, Math.max(proportional, toFit));
    target.territory -= sectors;
    me.territory += sectors;
    report.sectors = sectors;
  } else if (outcome.attackerWins) {
    const spoils = raidSpoils(rules, {
      capital: target.capital,
      users: target.users,
      buildingsExceptCores: totalBuildings(target) - target.buildings.core,
    });
    target.capital -= spoils.capital;
    me.capital += spoils.capital;
    target.users -= spoils.users;
    // Stolen users arrive up to the raider's cap; the rest are lost.
    const room = Math.max(0, userCap(rules, me.buildings.city, me.territory) - me.users);
    me.users += Math.min(room, spoils.users);
    report.capital = spoils.capital;
    report.users = spoils.users;
    report.buildings = destroyBuildings(rules, target, spoils.buildings);
  }

  noteAggression(rules, target, me, now);
  leaveSafeMode(me);
  emit(world, ctx.events, now, { type: "battle", ...publicLine(report) });
  const reported = emit(world, ctx.events, now, { type: "battle_report", ...report });
  if (outcome.attackerWins) noteHit(rules, world, target, now, ctx.events);
  if (target.buildings.core === 0) deleteMind(world, target, now, ctx.events, me);
  else if (outcome.attackerWins && order.mode === "conquest" && target.convergedAt !== null) collapse(world, now, ctx.events, "defeated");
  spend(ctx, cost);
  me.attacksMade.push(now);
  return { do: order.do, ok: true, cycles: cost, message: describe(rules, reported) };
}

/** The part of a battle report the public Record shows. */
function publicLine(r: BattleReport): BattleLine {
  const { attacker, defender, attackerName, defenderName, mode, attackerWon, sectors, cores, capital, users, buildings } = r;
  return { attacker, defender, attackerName, defenderName, mode, attackerWon, sectors, cores, capital, users, buildings };
}

// ── Hostile programs and Probe ──────────────────────────────────────────

/**
 * What a landed hostile program does to its target. Mutates both domains.
 * Keys: architectures.<a>.programs.<hostile>.*, as scaledShare
 */
function hostileEffect(ctx: OrderContext, program: Program, target: Domain): HostileEffect {
  const { rules, domain: me, now } = ctx;
  const cap = capability(me);
  const a = rules.architectures;
  switch (program) {
    case "decommission": {
      const share = scaledShare(rules, a.steward.programs.decommission.deployment_share, cap);
      let deployments = 0;
      for (const [unit, count] of unitCounts(target)) {
        if (unitStats(rules, unit).kind !== "deployment") continue;
        const k = Math.floor(count * share);
        target.units[unit] = count - k;
        deployments += k;
      }
      return { deployments };
    }
    case "blight": {
      const p = a.symbiote.programs.blight;
      const capital = Math.floor(target.capital * scaledShare(rules, p.capital_share, cap));
      target.capital -= capital;
      const until = now + p.stall_hours * HOUR_MS;
      target.growthStalledUntil = Math.max(target.growthStalledUntil ?? 0, until);
      return { capital, stallHours: p.stall_hours };
    }
    case "kinetic_cascade": {
      const nonCore = totalBuildings(target) - target.buildings.core;
      const count = Math.floor(nonCore * scaledShare(rules, a.accelerant.programs.kinetic_cascade.building_share, cap));
      return { buildings: destroyBuildings(rules, target, count) };
    }
    case "harvest": {
      const users = Math.floor(target.users * scaledShare(rules, a.assimilator.programs.harvest.user_share, cap));
      target.users -= users;
      return { users };
    }
    case "exfiltration": {
      const p = a.oracle.programs.exfiltration;
      const compute = Math.floor(target.compute * scaledShare(rules, p.compute_share, cap));
      target.compute -= compute;
      addCompute(rules, me, compute);
      syncCycles(rules, target, now);
      const cycles = Math.min(p.cycles, target.cycles);
      target.cycles -= cycles;
      me.cycles = Math.min(rules.cycles.cap, me.cycles + cycles);
      return { compute, cycles };
    }
    default:
      throw new Error(`not a hostile program: ${program}`);
  }
}

/** Hostile programs that take capital or compute, which escrow mustn't shelter. */
const TAKES_GOODS: ReadonlySet<Program> = new Set(["blight", "exfiltration"]);

/**
 * Runs a hostile program or Probe on another mind. Protection and the
 * hostile cap are checked first (nothing spent); then compute and the cycle
 * are spent, the crash drawn, and for a hostile program the firewall block
 * drawn. A program that reaches the target counts toward its cap, blocked
 * or not. Keys: action_cycles.execute, as the helpers it calls
 */
export function executeAgainst(ctx: OrderContext, order: Extract<Order, { do: "execute" }>, program: Program, targetText: string): OrderResult {
  const { rules, world, domain: me, now, rng } = ctx;
  const name = programName(rules, program);
  const target = findTarget(ctx, targetText);
  if (typeof target === "string") return fail(order, target);
  const hostile = PROGRAM_INFO.get(program)!.kind === "hostile";
  if (hostile) {
    const shield = shieldedBecause(rules, me, target, now);
    if (shield) return fail(order, shield);
    if (hostileCapReached(rules, target, now)) return fail(order, `${target.designation} has taken all the hostile programs it can today.`);
  }
  const cycles = rules.action_cycles.execute;
  if (me.cycles < cycles) return outOfCycles(order, cycles, me.cycles);
  const compute = programCompute(rules, program);
  if (me.compute < compute) return fail(order, `${name} needs ${n(compute)} compute; you have ${n(me.compute)}.`);

  me.compute -= compute;
  if (hostile) leaveSafeMode(me);
  if (rng.next() < programCrashChance(rules, program, capability(me))) {
    spend(ctx, cycles);
    return { do: order.do, ok: false, cycles, message: `${name} crashed: ${n(compute)} compute spent, nothing happened.` };
  }

  if (!hostile) {
    const status = domainStatus(rules, target, now);
    emit(world, ctx.events, now, { type: "probed", domain: me.id, target: target.id, targetName: target.designation });
    spend(ctx, cycles);
    return {
      do: order.do,
      ok: true,
      cycles,
      message: `Probed ${target.designation}: power ${n(status.power)}, ${n(status.cycles)} cycles, capability ${n(status.capability)}.`,
      status,
    };
  }

  noteHostile(target, now);
  noteAggression(rules, target, me, now);
  const blocked = rng.next() < firewallBlockChance(rules, target.buildings.firewall, target.territory);
  if (!blocked && TAKES_GOODS.has(program)) withdrawOffers(rules, world, target, now, ctx.events);
  const effect = blocked ? {} : hostileEffect(ctx, program, target);
  const event = emit(world, ctx.events, now, {
    type: "hostile",
    caster: me.id,
    target: target.id,
    casterName: me.designation,
    targetName: target.designation,
    program,
    blocked,
    effect,
  });
  spend(ctx, cycles);
  return { do: order.do, ok: !blocked, cycles, message: describe(rules, event) };
}
