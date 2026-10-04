import { PROGRAM_INFO, type Program, type Tier } from "./architectures.js";
import { atTier, type Rules } from "./rules.js";

// Research, capability and the numbers every program shares: tier, research
// cost, compute cost, crash chance, effect scaling, deployment size and
// firewall blocking. What each program does is the engine's job in phase 2;
// its numbers are in config/rules.yaml under architectures.<a>.programs.

/**
 * A program's tier: deployments by their column, the rest by kind. The
 * Singularity has no tier. Keys: research.tier_by_kind
 */
export function programTier(rules: Rules, program: Program): Tier | undefined {
  const info = PROGRAM_INFO.get(program);
  if (!info) throw new Error(`unknown program: ${program}`);
  if (info.kind === "deploy") return info.deployTier;
  if (info.kind === "singularity") return undefined;
  return rules.research.tier_by_kind[info.kind];
}

/** Research points to learn a program. Keys: research.cost_by_tier, programs.singularity.research */
export function researchCost(rules: Rules, program: Program): number {
  const tier = programTier(rules, program);
  if (tier === undefined) return rules.programs.singularity.research;
  return atTier(rules.research.cost_by_tier, tier);
}

/**
 * Compute to run a program once. Keys: programs.deploy.compute_by_tier,
 * programs.probe.compute, programs.singularity.compute,
 * architectures.<a>.programs.<id>.compute
 */
export function programCompute(rules: Rules, program: Program): number {
  const info = PROGRAM_INFO.get(program)!;
  switch (info.kind) {
    case "probe":
      return rules.programs.probe.compute;
    case "singularity":
      return rules.programs.singularity.compute;
    case "deploy":
      return atTier(rules.programs.deploy.compute_by_tier, info.deployTier!);
    default: {
      const programs = rules.architectures[info.architecture!].programs as Record<string, { compute: number }>;
      return programs[program]!.compute;
    }
  }
}

/**
 * Chance a program of this tier crashes, for a mind of this capability.
 * Keys: capability.crash_by_tier, capability.crash_per_program, capability.crash_min
 */
export function crashChance(rules: Rules, tier: Tier, capability: number): number {
  const c = rules.capability;
  return Math.max(c.crash_min, atTier(c.crash_by_tier, tier) - c.crash_per_program * capability);
}

/** Chance a program crashes, by id. Keys: as crashChance, plus programs.singularity.can_crash */
export function programCrashChance(rules: Rules, program: Program, capability: number): number {
  const tier = programTier(rules, program);
  if (tier === undefined) {
    // A Singularity that can crash crashes like a tier-3 program.
    return rules.programs.singularity.can_crash ? crashChance(rules, 3, capability) : 0;
  }
  return crashChance(rules, tier, capability);
}

/** The multiplier capability applies to effect sizes. Keys: capability.effect_per_program */
export function effectScale(rules: Rules, capability: number): number {
  return 1 + rules.capability.effect_per_program * capability;
}

/** An effect size (a bonus, a reduction) scaled by capability. */
export function scaledEffect(rules: Rules, base: number, capability: number): number {
  return base * effectScale(rules, capability);
}

/** A share or a chance scaled by capability, never past 1. */
export function scaledShare(rules: Rules, base: number, capability: number): number {
  return Math.min(1, scaledEffect(rules, base, capability));
}

/**
 * Units one run of a deployment program brings.
 * Keys: programs.deploy.count_by_tier, capability.deploy_per_program
 */
export function deployCount(rules: Rules, tier: Tier, capability: number): number {
  const base = atTier(rules.programs.deploy.count_by_tier, tier);
  return Math.floor(base * (1 + rules.capability.deploy_per_program * capability));
}

/** Chance a hostile program is blocked by the target's firewalls. Keys: firewall.* */
export function firewallBlockChance(rules: Rules, firewalls: number, territory: number): number {
  return Math.min(rules.firewall.block_max, (rules.firewall.block_per_share * firewalls) / territory);
}
