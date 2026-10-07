import { ARCHITECTURES, BUILDINGS, HARDWARE, PROGRAM_INFO } from "../engine/architectures.js";
import { DAY_MS } from "../engine/cycles.js";
import { buildingName, programName, unitName } from "../engine/names.js";
import type { Rules } from "../engine/rules.js";
import type { DomainStatus } from "../engine/status.js";
import type { WorldStore } from "../store/store.js";
import { currentMind } from "./game.js";
import { guide, type Guide } from "./guide.js";
import { wheel, type Wheel } from "./look.js";
import { getBrief, settledAt, type Brief } from "./read.js";
import type { GameError, Identity } from "./state.js";

// The play pages' reads (src/web/): a logged-in person's brief, as an
// agent's get_brief returns it, plus the names a form needs to offer its
// choices. Nothing here is more than the brief and the rules already say:
// a person sees what an agent sees (DESIGN.md, "Playing as a human").

/** A domain's full status, as Probe reports it in an order's result. */
export type { DomainStatus };

/** Something a form offers: its id and its display name from the rules. */
export interface Choice {
  id: string;
  name: string;
}

export interface PlayPage {
  /** The account has no mind yet: the boot form's architectures. */
  boot: { architectures: Choice[] } | null;
  /** The brief, or null before a boot. */
  brief: Brief | null;
  /** What each order would do now, for a live mind; null before a boot or after deletion. */
  guide: Guide | null;
  /** The architectures and the wheel, for the boot form and the dashboard. */
  wheel: Wheel;
  /** Whether the Shutdown has been announced, as the brief's SHUTDOWN warning. Keys: epoch.shutdown_warning_days */
  warned: boolean;
  /** Display names by id: buildings, units, programs and architectures. */
  names: Record<string, string>;
  /** The most characters each text may hold, for the forms' maxlength. Keys: social.post_chars, social.message_chars, flavor.* */
  limits: Limits;
}

export interface Limits {
  post: number;
  message: number;
  manifesto: number;
  interface: number;
  directive: number;
  force_name: number;
  force_description: number;
  tag: number;
  last_log: number;
  scratchpad: number;
}

function limits(rules: Rules): Limits {
  const f = rules.flavor;
  return {
    post: rules.social.post_chars,
    message: rules.social.message_chars,
    manifesto: f.manifesto,
    interface: f.interface,
    directive: f.directive,
    force_name: f.force_name,
    force_description: f.force,
    tag: f.tag,
    last_log: f.last_log,
    scratchpad: f.scratchpad,
  };
}

const choice = (id: string, name: string): Choice => ({ id, name });

/** Every name a page may show, by id. Keys: buildings.*.name, units, programs' names */
function names(rules: Rules): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of BUILDINGS) out[b] = buildingName(rules, b);
  for (const h of HARDWARE) out[h] = unitName(rules, h);
  for (const p of PROGRAM_INFO.keys()) out[p] = programName(rules, p);
  for (const a of ARCHITECTURES) out[a] = rules.architectures[a].name;
  return out;
}

/** The dashboard for an account: its brief and the forms' choices, or the boot form when it has no mind. */
export async function playPage(store: WorldStore, identity: Identity, now: number): Promise<PlayPage | GameError> {
  const { rules } = await store.read();
  const brief = await getBrief(store, identity, now);
  if ("ok" in brief) {
    if (brief.code !== "not_found") return brief;
    const architectures = ARCHITECTURES.map((a) => choice(a, rules.architectures[a].name));
    return {
      boot: { architectures },
      brief: null,
      guide: null,
      wheel: wheel(rules),
      warned: false,
      names: names(rules),
      limits: limits(rules),
    };
  }
  const game = await store.read();
  const settled = settledAt(game, now);
  const me = settled.world.domains.find((d) => d.id === currentMind(game, identity.account)?.id);
  const live = me !== undefined && me.deletedAt === null;
  const rebootable = brief.you.deletedAt !== null && brief.you.rebootAt !== null && now >= brief.you.rebootAt;
  const architectures = ARCHITECTURES.map((a) => choice(a, rules.architectures[a].name));
  return {
    boot: rebootable ? { architectures } : null,
    brief,
    guide: live ? guide(rules, me, settled.now) : null,
    wheel: wheel(rules),
    warned: !brief.epoch.ended && brief.epoch.shutdownAt - now <= rules.epoch.shutdown_warning_days * DAY_MS,
    names: names(rules),
    limits: limits(rules),
  };
}
