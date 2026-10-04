import { z } from "zod";

// The shape of config/rules.yaml. Every object is strict, so a misspelled key
// is an error rather than a silently missing number. The engine receives a
// parsed Rules value; reading the file is src/config.ts's job, since the
// engine does no I/O.

const count = z.number().int().nonnegative();
const positiveCount = z.number().int().positive();
const positive = z.number().positive();

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
  cores: positiveCount,
});

const CombatSchema = z.strictObject({
  random_spread: z.number().min(0).lt(1),
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
  messages_per_day: count,
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

export const RulesSchema = z
  .strictObject({
    cycles: CyclesSchema,
    action_cycles: ActionCyclesSchema,
    epoch: EpochSchema,
    start: StartSchema,
    combat: CombatSchema,
    protection: ProtectionSchema,
    deletion: DeletionSchema,
    convergence: ConvergenceSchema,
    social: SocialSchema,
    flavor: FlavorSchema,
  })
  // DESIGN.md: the quorum's floor exists so no single protocol can end the
  // world on its own; it always needs an outsider.
  .refine((r) => r.convergence.quorum_min > r.social.protocol_max_members, {
    message: "convergence.quorum_min must exceed social.protocol_max_members",
  });

export type Rules = z.infer<typeof RulesSchema>;
