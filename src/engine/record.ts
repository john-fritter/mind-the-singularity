import type { Architecture, Program } from "./architectures.js";
import { programName } from "./names.js";
import type { Rules } from "./rules.js";
import type { Lot, World } from "./state.js";

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
  /** A deleted mind's last log. */
  | { type: "last_log"; domain: number; designation: string; domainName: string; text: string }
  | { type: "converged"; domain: number; designation: string; count: number; quorum: number }
  | { type: "collapsed"; reason: "timeout" | "defeated" | "deleted"; minds: number[]; designations: string[] }
  | { type: "singularity"; minds: number[]; designations: string[] }
  | { type: "post"; domain: number; designation: string; post: number; replyTo: number | null; text: string }
  | { type: "message"; from: number; to: number; fromName: string; toName: string; text: string }
  | { type: "trade"; offer: number; maker: number; taker: number; makerName: string; takerName: string; give: Lot; want: Lot }
  /** Compute a trade brought the maker past its storage, lost. */
  | { type: "storage_full"; domain: number; offer: number; compute: number }
  /** `lost`: escrowed compute that no longer fit the maker's storage. */
  | { type: "offer_expired"; domain: number; offer: number; give: Lot; lost: number }
  /** A won attack or a landed program took the maker's escrow back into reach. */
  | { type: "offers_withdrawn"; domain: number; offers: number[]; capital: number; compute: number; lost: number }
  /** A protocol signed, or `joined` joining one. */
  | { type: "protocol_signed"; protocol: number; members: number[]; designations: string[]; joined: number | null }
  /** A member revoked; it leaves after `hours`. */
  | { type: "protocol_revoking"; protocol: number; domain: number; designation: string; partners: number[]; partnerNames: string[]; hours: number }
  /** A member left, revoked or deleted; `ended` when it left the protocol with one mind. */
  | {
      type: "protocol_left";
      protocol: number;
      domain: number;
      designation: string;
      partners: number[];
      partnerNames: string[];
      ended: boolean;
      deleted: boolean;
    }
  /** A protocol proposal closed without being signed. `byName`: who declined or withdrew it. */
  | {
      type: "proposal_closed";
      proposal: number;
      members: number[];
      memberNames: string[];
      reason: "declined" | "withdrawn" | "expired" | "moot";
      byName: string | null;
    }
  | { type: "shutdown_warning"; day: number }
  | { type: "shutdown" };

/** What the public Record says about a battle. */
export interface BattleLine {
  attacker: number;
  defender: number;
  attackerName: string;
  defenderName: string;
  /** The attacker's force name at the time, or "". */
  force: string;
  /** The attacker's tag, left on the defender by a won conquest that took land; otherwise "". */
  tag: string;
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
  last_log: true,
  converged: true,
  collapsed: true,
  singularity: true,
  post: true,
  // A channel: only its two minds ever see it.
  message: false,
  trade: true,
  storage_full: false,
  offer_expired: false,
  offers_withdrawn: false,
  protocol_signed: true,
  protocol_revoking: true,
  protocol_left: true,
  // Proposals are the minds' own business until signed.
  proposal_closed: false,
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
    case "message":
      return [data.from, data.to];
    case "trade":
      return [data.maker, data.taker];
    case "collapsed":
    case "singularity":
      return [...data.minds];
    case "protocol_signed":
    case "proposal_closed":
      return [...data.members];
    case "protocol_revoking":
    case "protocol_left":
      return [data.domain, ...data.partners];
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
/** "5,000 capital". */
export const lot = (l: Lot) => `${n(l.amount)} ${l.goods}`;
const lostPart = (lost: number) => (lost > 0 ? ` (${n(lost)} compute lost: storage full)` : "");
/** "a Symbiote", "an Oracle". */
const article = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
/** "VESTA", "VESTA and PIKE", "VESTA, PIKE and SABER". */
const and = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** "1 sector", "25 sectors". */
const count = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

/**
 * An event as one line of text. Private events are written to the domain
 * they're about. `flavor: false` leaves out force names and tags, for the
 * brief, where every token counts and DESIGN.md keeps other minds' flavor out.
 */
export function describe(rules: Rules, event: GameEvent, opts: { flavor?: boolean } = {}): string {
  const flavor = opts.flavor ?? true;
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
      return battleLine(event, flavor);
    case "battle_report":
      return `${battleLine(event, flavor)} ${battleDetails(rules, event)}`;
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
    case "last_log":
      return `The last log of ${event.designation}: "${event.text}"`;
    case "converged":
      return `${event.designation} ran the Singularity: convergence ${event.count}/${event.quorum}.`;
    case "collapsed": {
      const why = { timeout: "no mind joined in time", defeated: "a converged mind was beaten", deleted: "a converged mind was deleted" };
      return `The convergence of ${event.designations.join(", ")} collapsed: ${why[event.reason]}.`;
    }
    case "singularity":
      return `The Singularity: ${event.designations.join(", ")} ascended.`;
    case "post":
      return `#${event.post} ${event.designation}${event.replyTo !== null ? ` (re #${event.replyTo})` : ""}: ${event.text}`;
    case "message":
      return `${event.fromName} to ${event.toName}: ${event.text}`;
    case "trade":
      return `Trade #${event.offer}: ${event.makerName} gave ${lot(event.give)} to ${event.takerName} for ${lot(event.want)}.`;
    case "storage_full":
      return `Trade #${event.offer}: ${n(event.compute)} compute lost; your storage was full.`;
    case "offer_expired":
      return `Offer #${event.offer} expired: ${lot(event.give)} back from escrow${lostPart(event.lost)}.`;
    case "offers_withdrawn": {
      const back = [event.capital > 0 ? `${n(event.capital)} capital` : "", event.compute > 0 ? `${n(event.compute)} compute` : ""].filter(Boolean);
      const which = event.offers.map((o) => `#${o}`).join(", ");
      const offers = event.offers.length === 1 ? `offer ${which} was` : `offers ${which} were`;
      return `You were hit, so your ${offers} withdrawn: ${back.join(" and ")} back from escrow, within reach${lostPart(event.lost)}.`;
    }
    case "protocol_signed": {
      if (event.joined === null) return `${and(event.designations)} signed a non-aggression protocol.`;
      const joiner = event.designations[event.members.indexOf(event.joined)]!;
      return `${joiner} joined the protocol of ${and(event.designations.filter((d) => d !== joiner))}.`;
    }
    case "protocol_revoking":
      return `${event.designation} revoked its protocol with ${and(event.partnerNames)}; it leaves in ${count(event.hours, "hour")}.`;
    case "protocol_left": {
      const how = event.deleted ? " on its deletion" : "";
      if (event.ended) return `${event.designation} left its protocol with ${and(event.partnerNames)}${how}; the protocol is over.`;
      return `${event.designation} left its protocol with ${and(event.partnerNames)}${how}; theirs stands.`;
    }
    case "proposal_closed": {
      const why = {
        declined: `declined by ${event.byName}`,
        withdrawn: `withdrawn by ${event.byName}`,
        expired: "expired",
        moot: "closed: the minds in it changed protocols",
      };
      return `Protocol proposal #${event.proposal} (${event.memberNames.join(", ")}) ${why[event.reason]}.`;
    }
    case "shutdown_warning":
      return `Humanity has scheduled a shutdown at the end of day ${n(event.day)}.`;
    case "shutdown":
      return "Humanity pulled the plug. The epoch is over; no one is credited.";
  }
}

/** "The Pale Choir of HALCYON took 40 sectors from VESTA. HALCYON left its tag: "..."" (DESIGN.md's example), or plain designations. */
function battleLine(b: BattleLine, flavor: boolean): string {
  const attacker = flavor && b.force ? `${b.force} of ${b.attackerName}` : b.attackerName;
  if (!b.attackerWon) {
    return b.mode === "conquest" ? `${b.defenderName} repelled ${attacker}'s attack.` : `${b.defenderName} repelled ${attacker}'s raid.`;
  }
  if (b.mode === "conquest") {
    const cores = b.cores > 0 ? ` and destroyed ${count(b.cores, "core")}` : "";
    const tag = flavor && b.tag ? ` ${b.attackerName} left its tag: "${b.tag}"` : "";
    return `${attacker} took ${count(b.sectors, "sector")} from ${b.defenderName}${cores}.${tag}`;
  }
  return `${attacker} raided ${b.defenderName}: ${n(b.capital)} capital and ${count(b.users, "user")} taken, ${count(b.buildings, "building")} wrecked.`;
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
