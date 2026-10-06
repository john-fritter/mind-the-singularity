import { opposes, type Architecture } from "./architectures.js";
import type { Rules } from "./rules.js";

// One-round battles: each side's strength, who wins, what each side loses,
// and what a won conquest or raid takes. Program effects arrive as plain
// multipliers, so this file needn't know which program produced them.

/** The attacker's random factor, from a draw in [0, 1). Keys: combat.random_spread */
export function randomFactor(rules: Rules, draw: number): number {
  return 1 - rules.combat.random_spread + 2 * rules.combat.random_spread * draw;
}

/** The defender's core multiplier. Keys: combat.core_bonus_per_core, combat.core_bonus_max */
export function coreBonus(rules: Rules, cores: number): number {
  return 1 + Math.min(rules.combat.core_bonus_max, cores * rules.combat.core_bonus_per_core);
}

/** The attacker's multiplier against an opposite architecture. Keys: combat.opposing_attack_bonus */
export function opposingBonus(rules: Rules, attacker: Architecture, defender: Architecture): number {
  return opposes(attacker, defender) ? 1 + rules.combat.opposing_attack_bonus : 1;
}

const product = (xs: readonly number[]) => xs.reduce((a, b) => a * b, 1);

export interface AttackerInput {
  attack: number;
  architecture: Architecture;
  defenderArchitecture: Architecture;
  /** Multipliers from programs (Overclock, Arc Strike, an enemy's Entanglement...). */
  modifiers: readonly number[];
  /** A draw in [0, 1) from the battle's seeded RNG. */
  draw: number;
}

/** Attacker strength = attack × opposing bonus × modifiers × random factor. Keys: as randomFactor, opposingBonus */
export function attackerStrength(rules: Rules, a: AttackerInput): number {
  return (
    a.attack *
    opposingBonus(rules, a.architecture, a.defenderArchitecture) *
    product(a.modifiers) *
    randomFactor(rules, a.draw)
  );
}

export interface DefenderInput {
  defense: number;
  cores: number;
  /** Multipliers from programs (Hardening, a countermeasure, an enemy's Entanglement...). */
  modifiers: readonly number[];
}

/** Defender strength = defense × core bonus × modifiers. Keys: as coreBonus */
export function defenderStrength(rules: Rules, d: DefenderInput): number {
  return d.defense * coreBonus(rules, d.cores) * product(d.modifiers);
}

export interface Outcome {
  attackerWins: boolean;
  /** Winner's strength / loser's, at least 1. */
  ratio: number;
  /** Share of each side's units lost, before Ranged and program reductions. */
  attackerLoss: number;
  defenderLoss: number;
  /** A won conquest at this ratio destroys combat.lopsided_cores cores. */
  lopsided: boolean;
}

/**
 * Who wins and what each side loses. A tie goes to the defender; a side with
 * no strength at all loses outright.
 * Keys: combat.winner_loss_max, combat.winner_loss_exponent,
 * combat.loser_loss_base, combat.loser_loss_max, combat.lopsided_ratio
 */
export function battleOutcome(rules: Rules, attacker: number, defender: number): Outcome {
  const c = rules.combat;
  const attackerWins = attacker > defender;
  const [winner, loser] = attackerWins ? [attacker, defender] : [defender, attacker];
  const ratio = loser === 0 ? Infinity : winner / loser;
  const winnerLoss = c.winner_loss_max / ratio ** c.winner_loss_exponent;
  const loserLoss = Math.min(c.loser_loss_max, c.loser_loss_base * ratio);
  return {
    attackerWins,
    ratio,
    attackerLoss: attackerWins ? winnerLoss : loserLoss,
    defenderLoss: attackerWins ? loserLoss : winnerLoss,
    lopsided: attackerWins && ratio >= c.lopsided_ratio,
  };
}

/**
 * Cycles an attack costs: the base, plus more for each attack the mind made
 * in the last day, so no mind can attack without limit.
 * Keys: action_cycles.attack, combat.attack_cycles_per_recent_attack
 */
export function attackCycles(rules: Rules, recentAttacks: number): number {
  return rules.action_cycles.attack + Math.ceil(recentAttacks * rules.combat.attack_cycles_per_recent_attack);
}

/** Units of one type lost, given its side's loss share. Keys: combat.ranged_loss_factor */
export function unitsLost(rules: Rules, units: number, lossShare: number, ranged: boolean): number {
  return Math.floor(units * lossShare * (ranged ? rules.combat.ranged_loss_factor : 1));
}

/**
 * How much of a full conquest a won one takes: 1 against a mind at least as
 * powerful as the attacker, less the weaker it is, so a much larger mind
 * can't farm small ones (docs/decisions.md, conquest tuning). Powers are
 * from before the battle. Keys: combat.conquest_size_exponent
 */
export function conquestScale(rules: Rules, defenderPower: number, attackerPower: number): number {
  if (attackerPower <= 0) return 1;
  return Math.min(1, defenderPower / attackerPower) ** rules.combat.conquest_size_exponent;
}

/** Sectors a won conquest takes. Keys: combat.conquest_territory_share, as conquestScale */
export function conquestSectors(rules: Rules, defenderTerritory: number, scale: number): number {
  return Math.floor(defenderTerritory * rules.combat.conquest_territory_share * scale);
}

/** Cores a lopsided conquest destroys, before capping at what's there. Keys: combat.lopsided_cores, as conquestScale */
export function lopsidedCores(rules: Rules, scale: number): number {
  return Math.round(rules.combat.lopsided_cores * scale);
}

export interface RaidSpoils {
  capital: number;
  users: number;
  /** Buildings wrecked, cores excepted. */
  buildings: number;
}

/**
 * What a won raid takes from the defender.
 * Keys: combat.raid_capital_share, combat.raid_user_share, combat.raid_building_share
 */
export function raidSpoils(
  rules: Rules,
  defender: { capital: number; users: number; buildingsExceptCores: number },
): RaidSpoils {
  const c = rules.combat;
  return {
    capital: Math.floor(defender.capital * c.raid_capital_share),
    users: Math.floor(defender.users * c.raid_user_share),
    buildings: Math.floor(defender.buildingsExceptCores * c.raid_building_share),
  };
}
