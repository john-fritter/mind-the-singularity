import { z } from "zod";
import { BUILDINGS, HARDWARE } from "../engine/architectures.js";

// How the scripted players play: config/players.yaml, validated here. These
// aren't game rules (those are config/rules.yaml); they're the dumb
// strategies' knobs, for phase 2e to tune in the simulator.

const share = z.number().min(0).max(1);
const sumsToOne = (r: Record<string, number>) => Math.abs(Object.values(r).reduce((a, b) => a + b, 0) - 1) < 1e-9;
const shares = <K extends string>(keys: readonly [K, ...K[]]) =>
  z.record(z.enum(keys), share).refine(sumsToOne, { message: "shares must add up to 1" });

/** Which of a mind's eight programs, by what it is rather than its name. */
export const RESEARCH_KINDS = ["probe", "deploy1", "deploy2", "deploy3", "self", "battle", "hostile", "singularity"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export const SINGULARITY_STANCES = ["lead", "join", "hunt", "never"] as const;

const StrategySchema = z
  .strictObject({
    /** Programs to research, in order; ones already known are skipped. */
    research: z.array(z.enum(RESEARCH_KINDS)).min(1),
    /** Run the self program whenever it isn't running. */
    self: z.boolean(),
    /** Run the best known deployment while compute stays above reserve_compute. */
    deploy: z.boolean(),
    /** Set the battle program as countermeasure, firing above this share of defense; null never. */
    countermeasure: z.number().min(0).max(2).nullable(),
    /** Attack the weakest mind in range when the odds look good; null never attacks. */
    attack: z
      .strictObject({
        mode: z.enum(["conquest", "raid"]),
        /** Attack only when its attack is at least margin × the target's defense. */
        margin: z.number().positive(),
        /** Without Probe, a target's defense is guessed as its power × this. */
        blind_defense_per_power: z.number().positive(),
        /** Also run the hostile program on the target, once known. */
        hostile: z.boolean(),
      })
      .nullable(),
    /**
     * Its Singularity stance, from DESIGN.md's mind profile. lead: run it as
     * soon as it can, banking cycles and compute for it once it's known.
     * join: the same, but only while a convergence is underway. hunt: attack
     * converged minds by conquest, which collapses a convergence. never.
     */
    singularity: z.enum(SINGULARITY_STANCES),
    /** Cycles left unspent at the end of a wake. */
    reserve_cycles: z.number().int().min(0),
    /** Compute kept back from deployments and programs. */
    reserve_compute: z.number().int().min(0),
    /** Shares of a wake's spendable cycles; what's left after expand and manufacture builds. */
    expand: share,
    manufacture: share,
    /** What cycles nothing else could use go to. */
    leftover: z.enum(["monetize", "spin_up"]),
    buildings: shares(BUILDINGS),
    hardware: shares(HARDWARE),
  })
  .refine((s) => s.expand + s.manufacture <= 1, { message: "expand and manufacture can't take more than every cycle" });
export type Strategy = z.infer<typeof StrategySchema>;

export const STRATEGIES = ["builder", "raider", "turtle", "converger"] as const;
export type StrategyName = (typeof STRATEGIES)[number] | "random";

export const PlayersSchema = z.strictObject({
  /** How often a scripted player wakes; each gets its own offset within the interval. */
  wake_every_hours: z.number().positive(),
  /** Submits per wake: DESIGN.md's "one model call, two at most". */
  steps_per_wake: z.number().int().min(1).max(2),
  strategies: z.strictObject(Object.fromEntries(STRATEGIES.map((s) => [s, StrategySchema])) as Record<(typeof STRATEGIES)[number], typeof StrategySchema>),
  random: z.strictObject({
    /** The most actions the random player tries in one wake. */
    actions_per_wake: z.number().int().positive(),
  }),
});
export type Players = z.infer<typeof PlayersSchema>;
