import { passCycle, type UpkeepLosses } from "./cycle.js";
import type { GameEvent } from "./record.js";
import type { Rng } from "./rng.js";
import type { Rules } from "./rules.js";
import type { Domain, World } from "./state.js";
import type { DomainStatus } from "./status.js";

// What every order works with, what it returns, and the helpers the order
// files share. Every order mutates the world it's given; world.ts hands
// them a copy.

export interface OrderContext {
  rules: Rules;
  world: World;
  domain: Domain;
  now: number;
  events: GameEvent[];
  /** Seeded for this order (see rng.ts). */
  rng: Rng;
  losses: UpkeepLosses;
}

export interface OrderResult {
  do: string;
  ok: boolean;
  /** Cycles the order spent. */
  cycles: number;
  message: string;
  /** What a Probe revealed. */
  status?: DomainStatus;
}

export const n = (x: number) => x.toLocaleString("en-US");
export const fail = (order: { do: string }, message: string): OrderResult => ({ do: order.do, ok: false, cycles: 0, message });
export const outOfCycles = (order: { do: string }, cost: number, have: number): OrderResult =>
  fail(order, `Out of cycles: this costs ${cost}, ${have} left.`);

/** Spends cycles, running one cycle's economy for each. */
export function spend(ctx: OrderContext, cycles: number): void {
  for (let i = 0; i < cycles; i++) {
    ctx.domain.cycles--;
    passCycle(ctx.rules, ctx.world, ctx.domain, ctx.now, ctx.events, ctx.losses);
  }
}
