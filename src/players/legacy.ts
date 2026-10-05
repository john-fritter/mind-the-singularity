import { DAY_MS, HOUR_MS } from "../engine/cycles.js";
import type { Rules } from "../engine/rules.js";
import { legacyAccount } from "../game/game.js";
import { Plan } from "./plan.js";
import type { Player, Wake } from "./player.js";

// The legacy systems (DESIGN.md, Defense, protection, and deletion): code-run
// domains that grow on a schedule and now and then raid a weak mind. They're
// players like any other, reading their brief and ordering through
// submitOrders; the game boots them with the epoch (game.ts). Their mixes
// and schedule are game rules, under `legacy` in config/rules.yaml.
//
// A legacy system keeps its memory in its scratchpad, as an agent would:
// the last wake it spent for, and when it next raids.

type System = Rules["legacy"]["systems"][number];

interface Memory {
  /** The wake number last spent for. */
  wake: number;
  /** When it next raids. */
  raidAt: number;
}

/** When the epoch started, from the brief. */
const epochStart = (wake: Wake) => wake.brief.epoch.shutdownAt - wake.brief.epoch.lengthDays * DAY_MS;

export class LegacyPlayer implements Player {
  readonly kind = "legacy";
  constructor(private readonly system: System) {}

  /** Its legacy account. */
  get account(): string {
    return legacyAccount(this.system.designation);
  }

  /** Hours to the next raid, drawn between the rules' bounds. Keys: legacy.raid_every_hours_min, legacy.raid_every_hours_max */
  private raidInterval(rules: Rules, draw: number): number {
    const l = rules.legacy;
    return (l.raid_every_hours_min + draw * (l.raid_every_hours_max - l.raid_every_hours_min)) * HOUR_MS;
  }

  private recall(wake: Wake, k: number): Memory {
    try {
      const m = JSON.parse(wake.brief.you.scratchpad) as Partial<Memory>;
      if (typeof m.wake === "number" && typeof m.raidAt === "number") return { wake: m.wake, raidAt: m.raidAt };
    } catch {
      // A first wake: nothing remembered yet.
    }
    return { wake: k - 1, raidAt: epochStart(wake) + this.raidInterval(wake.rules, wake.rng.next()) };
  }

  /**
   * One wake: a raid if one is due and a mind is in range, then the wake's
   * share of cycles_per_day in the order mix. The shares carry over by
   * counting wakes since the epoch began, so a day's mix comes out exact.
   * Keys: legacy.wake_every_hours, legacy.systems.*
   */
  decide(wake: Wake): unknown[] {
    const { rules, brief } = wake;
    if (wake.step > 1) return [];
    const plan = new Plan(rules, brief);
    if (!plan.live) return [];
    const sys = this.system;
    const now = brief.now;
    const k = Math.floor((now - epochStart(wake)) / (rules.legacy.wake_every_hours * HOUR_MS));
    const memory = this.recall(wake, k);
    if (k <= memory.wake) return [];

    if (sys.raids && now >= memory.raidAt) {
      const legacy = new Set(rules.legacy.systems.map((s) => s.designation));
      const minds = plan.targets().filter((t) => !legacy.has(t.designation));
      const victim = minds.reduce<(typeof minds)[number] | undefined>((w, t) => (w === undefined || t.power < w.power ? t : w), undefined);
      if (victim && plan.attackWith(victim.designation, "raid")) memory.raidAt = now + this.raidInterval(rules, wake.rng.next());
    }

    const perWake = (sys.cycles_per_day * rules.legacy.wake_every_hours) / 24;
    const due = (share: number) => Math.floor(k * perWake * share) - Math.floor(memory.wake * perWake * share);
    plan.expand(due(sys.orders.expand));
    plan.build(sys.buildings, due(sys.orders.build));
    plan.manufacture(sys.hardware, due(sys.orders.manufacture));
    plan.scratchpad(JSON.stringify({ wake: k, raidAt: memory.raidAt }));
    return plan.orders();
  }
}

/** One player per legacy system in the rules. */
export function legacyPlayers(rules: Rules): LegacyPlayer[] {
  return rules.legacy.systems.map((s) => new LegacyPlayer(s));
}
