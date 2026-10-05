import type { OrderResult } from "../engine/context.js";
import type { Rng } from "../engine/rng.js";
import type { Rules } from "../engine/rules.js";
import type { Brief } from "../game/read.js";

// What a scripted player is: a brief in, orders out. It sees what an agent
// sees: its own brief's data and the rules (what the `rules` tool gives),
// never the world. A wake may take two steps, as DESIGN.md allows an agent
// two model calls: the second sees a fresh brief and the first step's
// results (a Probe's report, say).

export interface Wake {
  brief: Brief;
  rules: Rules;
  /** 1 for the wake's first submit, 2 for its second. */
  step: number;
  /** The results of the wake's earlier step, if this is the second. */
  previous: OrderResult[] | null;
  /** Seeded for this player and this moment, for those that roll. */
  rng: Rng;
}

export interface Player {
  /** What it is, for reports: "builder", "legacy", ... */
  readonly kind: string;
  /** The orders for this step; an empty list ends the wake. */
  decide(wake: Wake): unknown[];
}
