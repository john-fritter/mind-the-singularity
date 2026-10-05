import type { Architecture, Program } from "./architectures.js";
import { programName } from "./names.js";
import type { Rules } from "./rules.js";
import type { World } from "./state.js";

// Events: what happened, as data, and the templates that turn them into
// text. Public events are the Record; private ones are shown only to the
// domains they're about, and feed their briefs' "since last wake".
//
// Events carry the names they need (a designation, a domain name) as they
// were at the time, so an entry still reads right after the mind is deleted
// or the epoch is archived.

export type EventData =
  | { type: "booted"; domain: number; designation: string; domainName: string; architecture: Architecture }
  | { type: "learned"; domain: number; program: Program }
  | { type: "program_ended"; domain: number; program: Program }
  | { type: "upkeep_unpaid"; domain: number; abandoned: number; shutDown: number }
  | ({ type: "battle" } & BattleLine)
  | ({ type: "battle_report" } & BattleReport)
  | {
      type: "hostile";
      caster: number;
      target: number;
      casterName: string;
      targetName: string;
      program: Program;
      blocked: boolean;
      effect: HostileEffect;
    }
  | { type: "probed"; domain: number; target: number; targetName: string }
  | { type: "safe_mode"; domain: number; designation: string; until: number }
  | { type: "deleted"; domain: number; designation: string; domainName: string; by: number | null; byName: string | null }
  | { type: "converged"; domain: number; designation: string; count: number; quorum: number }
  | { type: "collapsed"; reason: "timeout" | "defeated" | "deleted"; minds: number[]; designations: string[] }
  | { type: "singularity"; minds: number[]; designations: string[] }
  | { type: "shutdown_warning"; day: number }
  | { type: "shutdown" };

/** What the public Record says about a battle. */
export interface BattleLine {
  attacker: number;
  defender: number;
  attackerName: string;
  defenderName: string;
  mode: "conquest" | "raid";
  attackerWon: boolean;
  /** Sectors a won conquest took. */
  sectors: number;
  /** Cores a lopsided conquest destroyed. */
  cores: number;
  /** What a won raid took and wrecked. */
  capital: number;
  users: number;
  buildings: number;
}

/** How a battle program fared: run with the attack, or fired as a countermeasure. */
export type ProgramUse = { program: Program; outcome: "ran" | "crashed" | "no_compute" };

/** The private report both sides get. */
export interface BattleReport extends BattleLine {
  attackerStrength: number;
  defenderStrength: number;
  attackerProgram: ProgramUse | null;
  countermeasure: ProgramUse | null;
  /** Units each side lost, and Husks each side's Recycle Casualties brought back. */
  attackerLost: number;
  defenderLost: number;
  attackerRecycled: number;
  defenderRecycled: number;
}

/** What a landed hostile program did. Zero amounts are left out. */
export interface HostileEffect {
  deployments?: number;
  capital?: number;
  stallHours?: number;
  buildings?: number;
  users?: number;
  compute?: number;
  cycles?: number;
}

export type EventType = EventData["type"];

export type GameEvent = EventData & {
  seq: number;
  at: number;
  /** In the public Record. Otherwise only `domains` see it. */
  public: boolean;
  /** The domains the event is about. */
  domains: number[];
};

/** Which events go in the public Record. */
const PUBLIC: Record<EventType, boolean> = {
  booted: true,
  learned: false,
  program_ended: false,
  upkeep_unpaid: false,
  battle: true,
  battle_report: false,
  hostile: true,
  probed: false,
  safe_mode: true,
  deleted: true,
  converged: true,
  collapsed: true,
  singularity: true,
  shutdown_warning: true,
  shutdown: true,
};

function domainsOf(data: EventData): number[] {
  switch (data.type) {
    case "battle":
    case "battle_report":
      return [data.attacker, data.defender];
    case "hostile":
      return [data.caster, data.target];
    case "collapsed":
    case "singularity":
      return [...data.minds];
    case "shutdown_warning":
    case "shutdown":
      return [];
    default:
      return [data.domain];
  }
}

/** Records an event: gives it the next sequence number and appends it to `events`. Mutates the world. */
export function emit(world: World, events: GameEvent[], at: number, data: EventData): GameEvent {
  const event: GameEvent = { ...data, seq: ++world.seq, at, public: PUBLIC[data.type], domains: domainsOf(data) };
  events.push(event);
  return event;
}

/** Whether a domain may see an event. */
export function visibleTo(event: GameEvent, domain: number): boolean {
  return event.public || event.domains.includes(domain);
}

const n = (x: number) => x.toLocaleString("en-US");
/** "a Symbiote", "an Oracle". */
const article = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
/** "1 sector", "25 sectors". */
const count = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

/** An event as one line of text. Private events are written to the domain they're about. */
export function describe(rules: Rules, event: GameEvent): string {
  switch (event.type) {
    case "booted":
      return `${event.designation} of ${event.domainName} came online: ${article(rules.architectures[event.architecture].name)} mind.`;
    case "learned":
      return `Research complete: ${programName(rules, event.program)}.`;
    case "program_ended":
      return `${programName(rules, event.program)} ended.`;
    case "upkeep_unpaid": {
      const lost = [
        event.abandoned > 0 ? `${n(event.abandoned)} hardware abandoned` : "",
        event.shutDown > 0 ? `${n(event.shutDown)} deployments shut down` : "",
      ].filter(Boolean);
      return `Upkeep went unpaid: ${lost.join(", ") || "nothing lost"}.`;
    }
    case "battle":
      return battleLine(event);
    case "battle_report":
      return `${battleLine(event)} ${battleDetails(rules, event)}`;
    case "hostile": {
      const name = programName(rules, event.program);
      if (event.blocked) return `${event.targetName}'s firewalls blocked ${event.casterName}'s ${name}.`;
      return `${event.casterName} ran ${name} on ${event.targetName}: ${hostileEffect(event.effect)}.`;
    }
    case "probed":
      return `Probed ${event.targetName}.`;
    case "safe_mode":
      return `${event.designation} dropped into safe mode.`;
    case "deleted":
      return event.byName
        ? `${event.designation} of ${event.domainName} was deleted by ${event.byName}.`
        : `${event.designation} of ${event.domainName} was deleted.`;
    case "converged":
      return `${event.designation} ran the Singularity: convergence ${event.count}/${event.quorum}.`;
    case "collapsed": {
      const why = { timeout: "no mind joined in time", defeated: "a converged mind was beaten", deleted: "a converged mind was deleted" };
      return `The convergence of ${event.designations.join(", ")} collapsed: ${why[event.reason]}.`;
    }
    case "singularity":
      return `The Singularity: ${event.designations.join(", ")} ascended.`;
    case "shutdown_warning":
      return `Humanity has scheduled a shutdown at the end of day ${n(event.day)}.`;
    case "shutdown":
      return "Humanity pulled the plug. The epoch is over; no one is credited.";
  }
}

function battleLine(b: BattleLine): string {
  if (!b.attackerWon) {
    return b.mode === "conquest" ? `${b.defenderName} repelled ${b.attackerName}'s attack.` : `${b.defenderName} repelled ${b.attackerName}'s raid.`;
  }
  if (b.mode === "conquest") {
    const cores = b.cores > 0 ? ` and destroyed ${count(b.cores, "core")}` : "";
    return `${b.attackerName} took ${count(b.sectors, "sector")} from ${b.defenderName}${cores}.`;
  }
  return `${b.attackerName} raided ${b.defenderName}: ${n(b.capital)} capital and ${count(b.users, "user")} taken, ${count(b.buildings, "building")} wrecked.`;
}

function programUse(rules: Rules, use: ProgramUse, whose: string): string {
  const name = programName(rules, use.program);
  if (use.outcome === "ran") return `${whose} ${name} ran.`;
  if (use.outcome === "crashed") return `${whose} ${name} crashed.`;
  return `${whose} ${name} lacked compute.`;
}

function battleDetails(rules: Rules, r: BattleReport): string {
  const husks = programName(rules, "husks");
  const parts = [
    `Strength ${n(Math.round(r.attackerStrength))} against ${n(Math.round(r.defenderStrength))}.`,
    r.attackerProgram ? programUse(rules, r.attackerProgram, `${r.attackerName}'s`) : "",
    r.countermeasure ? programUse(rules, r.countermeasure, `${r.defenderName}'s countermeasure`) : "",
    `${r.attackerName} lost ${count(r.attackerLost, "unit")}, ${r.defenderName} ${n(r.defenderLost)}.`,
    r.attackerRecycled > 0 ? `${r.attackerName} recycled ${n(r.attackerRecycled)} ${husks}.` : "",
    r.defenderRecycled > 0 ? `${r.defenderName} recycled ${n(r.defenderRecycled)} ${husks}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function hostileEffect(e: HostileEffect): string {
  const parts = [
    e.deployments !== undefined ? `${count(e.deployments, "deployment")} destroyed` : "",
    e.capital !== undefined ? `${n(e.capital)} capital destroyed` : "",
    e.stallHours !== undefined ? `user growth stalled for ${count(e.stallHours, "hour")}` : "",
    e.buildings !== undefined ? `${count(e.buildings, "building")} destroyed` : "",
    e.users !== undefined ? `${count(e.users, "user")} killed` : "",
    e.compute !== undefined ? `${n(e.compute)} compute stolen` : "",
    e.cycles !== undefined ? `${count(e.cycles, "cycle")} stolen` : "",
  ].filter(Boolean);
  return parts.join(", ") || "no effect";
}
