import { loadSite } from "../config.js";
import { ARCHITECTURE_CONTENT, ARCHITECTURES, opposes, programsOf, wheelDistance, type Architecture } from "../engine/architectures.js";
import { programName, unitName } from "../engine/names.js";
import type { Rules } from "../engine/rules.js";

// How the web view shows the architectures: each one's emoji, color and
// words (config/site.yaml, architectures), its units and programs by name,
// and its place on the wheel (DESIGN.md, "The wheel"). Display only: the
// brief and the rules tool never carry any of it.

export type ArchitectureColor = "white" | "green" | "red" | "black" | "blue";

export interface ArchitectureLook {
  id: Architecture;
  name: string;
  emoji: string;
  color: ArchitectureColor;
  worldview: string;
  plays: string;
  /** Deployments, tier 1 to 3, by name. */
  deployments: string[];
  /** Self, battle and hostile programs, by name. */
  programs: { self: string; battle: string; hostile: string };
  /** The two architectures beside it on the wheel. */
  neighbors: Architecture[];
  /** The two across the wheel. */
  opposites: Architecture[];
}

/** The wheel, in order, with the bonus for attacking an opposite. Keys: combat.opposing_attack_bonus */
export interface Wheel {
  looks: ArchitectureLook[];
  opposingBonus: number;
}

/** Every architecture's look, in wheel order. */
export function wheel(rules: Rules): Wheel {
  const site = loadSite().architectures;
  const looks = ARCHITECTURES.map((a): ArchitectureLook => {
    const c = ARCHITECTURE_CONTENT[a];
    const own = programsOf(a);
    const named = (kind: "self" | "battle" | "hostile") => programName(rules, own.find((p) => p.kind === kind)!.id);
    return {
      id: a,
      name: rules.architectures[a].name,
      ...site[a],
      deployments: c.deployments.map((d) => unitName(rules, d)),
      programs: { self: named("self"), battle: named("battle"), hostile: named("hostile") },
      neighbors: ARCHITECTURES.filter((b) => wheelDistance(a, b) === 1),
      opposites: ARCHITECTURES.filter((b) => opposes(a, b)),
    };
  });
  return { looks, opposingBonus: rules.combat.opposing_attack_bonus };
}

/** Each architecture's emoji and color, in wheel order, for a badge wherever a mind is named. */
export function architectureMarks(): Record<string, { emoji: string; color: ArchitectureColor }> {
  const site = loadSite().architectures;
  return Object.fromEntries(ARCHITECTURES.map((a) => [a, { emoji: site[a].emoji, color: site[a].color }]));
}
