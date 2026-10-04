import { z } from "zod";
import { ARCHITECTURES, BUILDINGS, HARDWARE, type Tier } from "./architectures.js";

// The shape of config/rules.yaml. Every object is strict, so a misspelled key
// is an error rather than a silently missing number. The engine receives a
// parsed Rules value; reading the file is src/config.ts's job, since the
// engine does no I/O.
//
// Ids (architectures, buildings, units, programs) are fixed in
// architectures.ts; this schema requires a config entry for every one of
// them and rejects any other.

const count = z.number().int().nonnegative();
const positiveCount = z.number().int().positive();
const positive = z.number().positive();
const nonnegative = z.number().nonnegative();
/** A fraction of something: 0 to 1. */
const share = z.number().min(0).max(1);
/** A display name from the fiction. */
const name = z.string().min(1).max(40);
/** One number per tier, tier 1 first. */
const byTier = <T extends z.ZodType>(item: T) => z.tuple([item, item, item]);
const tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const ascending = (xs: readonly number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);
const sumsToOne = (shares: Record<string, number>) =>
  Math.abs(Object.values(shares).reduce((a, b) => a + b, 0) - 1) < 1e-9;

const CyclesSchema = z.strictObject({
  interval_minutes: positive,
  cap: positiveCount,
  start_full: z.boolean(),
});

const ActionCyclesSchema = z.strictObject({
  expand: positiveCount,
  build: positiveCount,
  manufacture: positiveCount,
  execute: positiveCount,
  attack: positiveCount,
  monetize: positiveCount,
  spin_up: positiveCount,
});

const EpochSchema = z
  .strictObject({
    length_days: positiveCount,
    shutdown_warning_days: positiveCount,
  })
  .refine((e) => e.shutdown_warning_days < e.length_days, {
    message: "shutdown_warning_days must be shorter than the epoch",
  });

const StartSchema = z.strictObject({
  territory: positiveCount,
  buildings: z.record(z.enum(BUILDINGS), count).refine((b) => b.core > 0, {
    message: "a domain must start with at least one core",
  }),
  users: count,
  capital: count,
  compute: count,
  hardware: z.record(z.enum(HARDWARE), count),
});

const EconomySchema = z.strictObject({
  capital_per_user: nonnegative,
  capital_per_city: nonnegative,
  compute_per_datacenter: nonnegative,
  compute_storage_base: count,
  compute_storage_per_datacenter: count,
  monetize_income_multiple: positive,
  spin_up_income_multiple: positive,
  shortfall_loss_share: share,
});

const UsersSchema = z.strictObject({
  per_city: count,
  per_sector: count,
  growth_rate: share,
  shrink_rate: share,
});

const ExpansionSchema = z.strictObject({
  yield_base: positive,
  yield_reference_territory: positive,
  yield_falloff: positive,
  yield_min: positiveCount,
});

const BuildSchema = z.strictObject({
  rate_base: positiveCount,
  rate_sectors_per_extra: positive,
  cost_territory_scale: positive,
});

const BuildingSchema = z.strictObject({
  name,
  capital: positive,
  upkeep: nonnegative,
});

const ManufactureSchema = z.strictObject({
  housing_per_factory: positiveCount,
  per_factory_per_batch: positiveCount,
});

const UnitStats = {
  name,
  attack: nonnegative,
  defense: nonnegative,
  upkeep: nonnegative,
  ranged: z.boolean(),
};

/** Hardware: costs capital and users (operators), upkeep in capital. */
const HardwareSchema = z.strictObject({
  ...UnitStats,
  capital: positive,
  users: count,
});

/** A deployment: launched by its program for compute, upkeep in compute. */
const DeploymentSchema = z.strictObject(UnitStats);

const ResearchSchema = z
  .strictObject({
    per_lab: positive,
    cost_by_tier: byTier(positiveCount),
    tier_by_kind: z.strictObject({
      probe: tier,
      self: tier,
      battle: tier,
      hostile: tier,
    }),
  })
  .refine((r) => ascending(r.cost_by_tier), { message: "research cost_by_tier must rise with tier" });

const CapabilitySchema = z
  .strictObject({
    effect_per_program: nonnegative,
    deploy_per_program: nonnegative,
    crash_by_tier: byTier(z.number().min(0).lt(1)),
    crash_per_program: nonnegative,
    crash_min: share,
  })
  .refine((c) => c.crash_by_tier.every((x) => c.crash_min <= x), {
    message: "crash_min must not exceed any tier's crash_by_tier",
  });

const Program = { name, compute: count };
const Duration = z.strictObject({ unit: z.enum(["cycles", "hours"]), length: positive });

const StewardSchema = z.strictObject({
  name,
  deployments: z.strictObject({ wardens: DeploymentSchema, sentinels: DeploymentSchema, seraphim: DeploymentSchema }),
  programs: z.strictObject({
    hardening: z.strictObject({ ...Program, defense_bonus: positive, duration: Duration }),
    restoration: z.strictObject({ ...Program, loss_reduction: share }),
    decommission: z.strictObject({ ...Program, deployment_share: share }),
  }),
});

const SymbioteSchema = z.strictObject({
  name,
  deployments: z.strictObject({
    spore_drones: DeploymentSchema,
    grove_walkers: DeploymentSchema,
    phoenix_forms: DeploymentSchema,
  }),
  programs: z.strictObject({
    abundance_protocol: z.strictObject({
      ...Program,
      user_growth_bonus: positive,
      capital_bonus: positive,
      duration: Duration,
    }),
    entanglement: z.strictObject({ ...Program, enemy_strength_reduction: share }),
    blight: z.strictObject({ ...Program, capital_share: share, stall_hours: positive }),
  }),
});

const AccelerantSchema = z.strictObject({
  name,
  deployments: z.strictObject({
    hunter_drones: DeploymentSchema,
    siege_frames: DeploymentSchema,
    dragon_platforms: DeploymentSchema,
  }),
  programs: z.strictObject({
    overclock: z.strictObject({ ...Program, attack_bonus: positive, duration: Duration }),
    arc_strike: z.strictObject({ ...Program, strength_bonus: positive }),
    kinetic_cascade: z.strictObject({ ...Program, building_share: share }),
  }),
});

const AssimilatorSchema = z.strictObject({
  name,
  deployments: z.strictObject({ husks: DeploymentSchema, reconstructed: DeploymentSchema, titans: DeploymentSchema }),
  programs: z.strictObject({
    assimilation: z.strictObject({ ...Program, user_share: share, compute_per_user: positive }),
    recycle_casualties: z.strictObject({ ...Program, recycled_share: share }),
    harvest: z.strictObject({ ...Program, user_share: share }),
  }),
});

const OracleSchema = z.strictObject({
  name,
  deployments: z.strictObject({ ghosts: DeploymentSchema, eidolons: DeploymentSchema, leviathans: DeploymentSchema }),
  programs: z.strictObject({
    false_signature: z.strictObject({ ...Program, decoy_loss_share: share, duration: Duration }),
    adversarial_input: z.strictObject({ ...Program, miss_chance: share, miss_strength_factor: share }),
    exfiltration: z.strictObject({ ...Program, compute_share: share, cycles: count }),
  }),
});

const ArchitecturesSchema = z.strictObject({
  steward: StewardSchema,
  symbiote: SymbioteSchema,
  accelerant: AccelerantSchema,
  assimilator: AssimilatorSchema,
  oracle: OracleSchema,
});

const ProgramsSchema = z.strictObject({
  deploy: z
    .strictObject({
      compute_by_tier: byTier(positiveCount),
      count_by_tier: byTier(positiveCount),
    })
    .refine((d) => ascending(d.compute_by_tier), { message: "deploy compute_by_tier must rise with tier" }),
  probe: z.strictObject(Program),
  singularity: z.strictObject({
    ...Program,
    research: positiveCount,
    cycles: positiveCount,
    can_crash: z.boolean(),
  }),
});

const FirewallSchema = z.strictObject({
  block_per_share: positive,
  block_max: share,
});

const CombatSchema = z
  .strictObject({
    random_spread: z.number().min(0).lt(1),
    core_bonus_per_core: nonnegative,
    core_bonus_max: nonnegative,
    opposing_attack_bonus: nonnegative,
    winner_loss_max: share,
    winner_loss_exponent: positive,
    loser_loss_base: share,
    loser_loss_max: share,
    ranged_loss_factor: share,
    lopsided_ratio: z.number().gt(1),
    lopsided_cores: positiveCount,
    conquest_territory_share: share,
    raid_capital_share: share,
    raid_user_share: share,
    raid_building_share: share,
  })
  .refine((c) => c.winner_loss_max < c.loser_loss_base, {
    message: "winner_loss_max must be below loser_loss_base, so even a narrow winner loses less than the loser",
  })
  .refine((c) => c.loser_loss_base <= c.loser_loss_max, { message: "loser_loss_base must not exceed loser_loss_max" });

const PowerSchema = z.strictObject({
  per_sector: nonnegative,
  per_building: nonnegative,
  per_force_point: nonnegative,
  per_capability: nonnegative,
});

const ProtectionSchema = z
  .strictObject({
    boot_hours: positive,
    range_min: positive,
    range_max: positive,
    retaliation_hours: positive,
    safe_mode_hits: positiveCount,
    safe_mode_window_hours: positive,
    safe_mode_hours: positive,
    hostile_programs_per_target_per_day: positiveCount,
  })
  .refine((p) => p.range_min <= 1 && p.range_max >= 1, {
    message: "the attack range must include equal power (range_min <= 1 <= range_max)",
  });

const DeletionSchema = z.strictObject({
  reboot_after_hours: positive,
});

const ConvergenceSchema = z
  .strictObject({
    quorum_divisor: positive,
    quorum_min: positiveCount,
    quorum_max: positiveCount,
    active_window_hours: positive,
    join_gap_hours: positive,
    collapse_after_hours: positive,
  })
  .refine((c) => c.quorum_min <= c.quorum_max, { message: "quorum_min must not exceed quorum_max" })
  .refine((c) => c.join_gap_hours < c.collapse_after_hours, {
    message: "join_gap_hours must be shorter than collapse_after_hours, or no convergence can grow",
  });

const SocialSchema = z.strictObject({
  commons_posts_per_day: count,
  messages_per_day: count,
  open_offers_max: count,
  trade_expiry_hours: positive,
  protocol_max_members: z.number().int().min(2),
  protocol_revoke_hours: positive,
});

const FlavorSchema = z.strictObject({
  designation: positiveCount,
  domain_name: positiveCount,
  manifesto: positiveCount,
  interface: positiveCount,
  directive: positiveCount,
  force: positiveCount,
  tag: positiveCount,
  last_log: positiveCount,
  scratchpad: positiveCount,
});

const shares = <K extends string>(keys: readonly [K, ...K[]]) =>
  z.record(z.enum(keys), share).refine(sumsToOne, { message: "shares must add up to 1" });

const LegacySystemSchema = z.strictObject({
  designation: z.string().min(1),
  domain_name: z.string().min(1),
  architecture: z.enum(ARCHITECTURES),
  scale: positive,
  cycles_per_day: positiveCount,
  raids: z.boolean(),
  orders: shares(["expand", "build", "manufacture"] as const),
  buildings: shares(BUILDINGS),
  hardware: shares(HARDWARE),
});

const LegacySchema = z
  .strictObject({
    wake_every_hours: positive,
    raid_every_hours_min: positive,
    raid_every_hours_max: positive,
    systems: z.array(LegacySystemSchema).min(1),
  })
  .refine((l) => l.raid_every_hours_min <= l.raid_every_hours_max, {
    message: "raid_every_hours_min must not exceed raid_every_hours_max",
  })
  .refine((l) => new Set(l.systems.map((s) => s.designation)).size === l.systems.length, {
    message: "legacy designations must be unique",
  });

export const RulesSchema = z
  .strictObject({
    cycles: CyclesSchema,
    action_cycles: ActionCyclesSchema,
    epoch: EpochSchema,
    start: StartSchema,
    economy: EconomySchema,
    users: UsersSchema,
    expansion: ExpansionSchema,
    build: BuildSchema,
    buildings: z.record(z.enum(BUILDINGS), BuildingSchema),
    manufacture: ManufactureSchema,
    hardware: z.record(z.enum(HARDWARE), HardwareSchema),
    research: ResearchSchema,
    capability: CapabilitySchema,
    programs: ProgramsSchema,
    architectures: ArchitecturesSchema,
    firewall: FirewallSchema,
    combat: CombatSchema,
    power: PowerSchema,
    protection: ProtectionSchema,
    deletion: DeletionSchema,
    convergence: ConvergenceSchema,
    social: SocialSchema,
    flavor: FlavorSchema,
    legacy: LegacySchema,
  })
  // DESIGN.md: the quorum's floor exists so no single protocol can end the
  // world on its own; it always needs an outsider.
  .refine((r) => r.convergence.quorum_min > r.social.protocol_max_members, {
    message: "convergence.quorum_min must exceed social.protocol_max_members",
  })
  .superRefine((r, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const s = r.start;

    // The starting domain has to be a legal domain.
    const built = Object.values(s.buildings).reduce((a, b) => a + b, 0);
    if (built > s.territory) issue(["start", "buildings"], `start has ${built} buildings on ${s.territory} sectors`);
    const userCap = s.buildings.city * r.users.per_city + s.territory * r.users.per_sector;
    if (s.users > userCap) issue(["start", "users"], `start users exceed the starting user cap of ${userCap}`);
    const storage = r.economy.compute_storage_base + s.buildings.datacenter * r.economy.compute_storage_per_datacenter;
    if (s.compute > storage) issue(["start", "compute"], `start compute exceeds the starting storage of ${storage}`);
    const hardware = Object.values(s.hardware).reduce((a, b) => a + b, 0);
    const housing = s.buildings.factory * r.manufacture.housing_per_factory;
    if (hardware > housing) issue(["start", "hardware"], `start hardware exceeds the starting housing of ${housing}`);

    // The Singularity has to be runnable: its cycles fit under the cap, and
    // its compute fits in storage (which grows with datacenters, so only the
    // per-datacenter storage has to be positive).
    if (r.programs.singularity.cycles > r.cycles.cap) {
      issue(["programs", "singularity", "cycles"], "the Singularity costs more cycles than the cap can hold");
    }
    if (r.programs.singularity.compute > r.economy.compute_storage_base && r.economy.compute_storage_per_datacenter === 0) {
      issue(["programs", "singularity", "compute"], "the Singularity costs more compute than storage can ever hold");
    }

    // Legacy systems' names obey the same limits as minds'.
    r.legacy.systems.forEach((l, i) => {
      if (l.designation.length > r.flavor.designation) {
        issue(["legacy", "systems", i, "designation"], `longer than flavor.designation (${r.flavor.designation})`);
      }
      if (l.domain_name.length > r.flavor.domain_name) {
        issue(["legacy", "systems", i, "domain_name"], `longer than flavor.domain_name (${r.flavor.domain_name})`);
      }
    });
  });

export type Rules = z.infer<typeof RulesSchema>;

/** The entry for a tier in one of the rules' by-tier lists. */
export function atTier<T>(byTier: readonly [T, T, T], tier: Tier): T {
  return byTier[tier - 1]!;
}
