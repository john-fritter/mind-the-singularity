import type { Rules } from "./rules.js";

/**
 * Minds needed for the Singularity, given how many domains are active.
 * Keys: convergence.quorum_divisor, convergence.quorum_min, convergence.quorum_max
 */
export function quorum(rules: Rules, activeDomains: number): number {
  const c = rules.convergence;
  return Math.min(c.quorum_max, Math.max(c.quorum_min, Math.ceil(activeDomains / c.quorum_divisor)));
}
