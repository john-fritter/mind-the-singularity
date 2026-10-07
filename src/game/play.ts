import { ARCHITECTURES, BUILDINGS, HARDWARE, PROGRAM_INFO, programsOf, type Architecture, type Program } from "../engine/architectures.js";
import { DAY_MS } from "../engine/cycles.js";
import { buildingName, programName, unitName } from "../engine/names.js";
import type { Rules } from "../engine/rules.js";
import type { DomainStatus } from "../engine/status.js";
import type { WorldStore } from "../store/store.js";
import { getBrief, type Brief } from "./read.js";
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
  /** Whether the Shutdown has been announced, as the brief's SHUTDOWN warning. Keys: epoch.shutdown_warning_days */
  warned: boolean;
  /** Display names by id: buildings, units, programs and architectures. */
  names: Record<string, string>;
  /** What each order form may choose from. */
  choices: {
    buildings: Choice[];
    hardware: Choice[];
    /** The programs the mind's architecture can learn and it doesn't know yet. */
    research: Choice[];
    /** Known programs that run on their own: execute. */
    execute: Choice[];
    /** Known battle programs: with an attack, or as a countermeasure. */
    battle: Choice[];
  };
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

function choices(rules: Rules, architecture: Architecture, known: Program[]): PlayPage["choices"] {
  const programs = programsOf(architecture);
  const named = (p: Program) => choice(p, programName(rules, p));
  return {
    buildings: BUILDINGS.map((b) => choice(b, buildingName(rules, b))),
    hardware: HARDWARE.map((h) => choice(h, unitName(rules, h))),
    research: programs.filter((p) => !known.includes(p.id)).map((p) => named(p.id)),
    execute: programs.filter((p) => known.includes(p.id) && p.kind !== "battle").map((p) => named(p.id)),
    battle: programs.filter((p) => known.includes(p.id) && p.kind === "battle").map((p) => named(p.id)),
  };
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
      warned: false,
      names: names(rules),
      choices: { buildings: [], hardware: [], research: [], execute: [], battle: [] },
      limits: limits(rules),
    };
  }
  const rebootable = brief.you.deletedAt !== null && brief.you.rebootAt !== null && now >= brief.you.rebootAt;
  const architectures = ARCHITECTURES.map((a) => choice(a, rules.architectures[a].name));
  return {
    boot: rebootable ? { architectures } : null,
    brief,
    warned: !brief.epoch.ended && brief.epoch.shutdownAt - now <= rules.epoch.shutdown_warning_days * DAY_MS,
    names: names(rules),
    choices: choices(rules, brief.you.architecture, brief.you.known),
    limits: limits(rules),
  };
}
