// The fixed structure of the game: which architectures exist, which units and
// programs each one has, and how they sit on the wheel. These are ids, not
// numbers; every name shown to players and every number lives in
// config/rules.yaml under the same ids.

/** The wheel, in order: each architecture neighbors the ones beside it. */
export const ARCHITECTURES = ["steward", "symbiote", "accelerant", "assimilator", "oracle"] as const;
export type Architecture = (typeof ARCHITECTURES)[number];

export const BUILDINGS = ["city", "datacenter", "factory", "lab", "core", "firewall"] as const;
export type Building = (typeof BUILDINGS)[number];

/** Hardware every architecture can manufacture. */
export const HARDWARE = ["drones", "sentries", "walkers"] as const;
export type Hardware = (typeof HARDWARE)[number];

/**
 * Each architecture's deployments, by tier (tier 1 first), and its three
 * other programs. A deployment's program has the deployment's id.
 */
export const ARCHITECTURE_CONTENT = {
  steward: {
    deployments: ["wardens", "sentinels", "seraphim"],
    self: "hardening",
    battle: "restoration",
    hostile: "decommission",
  },
  symbiote: {
    deployments: ["spore_drones", "grove_walkers", "phoenix_forms"],
    self: "abundance_protocol",
    battle: "entanglement",
    hostile: "blight",
  },
  accelerant: {
    deployments: ["hunter_drones", "siege_frames", "dragon_platforms"],
    self: "overclock",
    battle: "arc_strike",
    hostile: "kinetic_cascade",
  },
  assimilator: {
    deployments: ["husks", "reconstructed", "titans"],
    self: "assimilation",
    battle: "recycle_casualties",
    hostile: "harvest",
  },
  oracle: {
    deployments: ["ghosts", "eidolons", "leviathans"],
    self: "false_signature",
    battle: "adversarial_input",
    hostile: "exfiltration",
  },
} as const;

type Content = typeof ARCHITECTURE_CONTENT;
export type Deployment = Content[Architecture]["deployments"][number];
export type Unit = Hardware | Deployment;
export type ArchitectureProgram =
  | Content[Architecture]["self"]
  | Content[Architecture]["battle"]
  | Content[Architecture]["hostile"];
/** Programs every mind can research. */
export const UNIVERSAL_PROGRAMS = ["probe", "singularity"] as const;
export type Program = Deployment | ArchitectureProgram | (typeof UNIVERSAL_PROGRAMS)[number];

export type ProgramKind = "deploy" | "self" | "battle" | "hostile" | "probe" | "singularity";

/** A deployment tier: 1, 2 or 3. */
export type Tier = 1 | 2 | 3;

export interface ProgramInfo {
  id: Program;
  kind: ProgramKind;
  /** Undefined for the universal programs. */
  architecture?: Architecture;
  /** Set for deployments only; other kinds take their tier from the rules. */
  deployTier?: Tier;
}

/** The eight programs a mind of this architecture can learn: Probe, deployments by tier, self, battle, hostile, the Singularity. */
export function programsOf(architecture: Architecture): ProgramInfo[] {
  const c = ARCHITECTURE_CONTENT[architecture];
  return [
    { id: "probe", kind: "probe" },
    ...c.deployments.map((id, i): ProgramInfo => ({ id, kind: "deploy", architecture, deployTier: (i + 1) as Tier })),
    { id: c.self, kind: "self", architecture },
    { id: c.battle, kind: "battle", architecture },
    { id: c.hostile, kind: "hostile", architecture },
    { id: "singularity", kind: "singularity" },
  ];
}

/** Every program in the game, by id. The universal ones appear once. */
export const PROGRAM_INFO: ReadonlyMap<Program, ProgramInfo> = new Map(
  ARCHITECTURES.flatMap((a) => programsOf(a)).map((p) => [p.id, p]),
);

/** Steps between two architectures around the wheel: 0, 1 (neighbors) or 2 (opposites). */
export function wheelDistance(a: Architecture, b: Architecture): 0 | 1 | 2 {
  const n = ARCHITECTURES.length;
  const d = Math.abs(ARCHITECTURES.indexOf(a) - ARCHITECTURES.indexOf(b));
  return Math.min(d, n - d) as 0 | 1 | 2;
}

/** Whether two architectures are opposites on the wheel (not the same, not neighbors). */
export function opposes(a: Architecture, b: Architecture): boolean {
  return wheelDistance(a, b) === 2;
}
