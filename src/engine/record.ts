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
  | { type: "upkeep_unpaid"; domain: number; abandoned: number; shutDown: number };

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
};

function domainsOf(data: EventData): number[] {
  return [data.domain];
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

/** An event as one line of text. Private events are written to the domain they're about. */
export function describe(rules: Rules, event: GameEvent): string {
  switch (event.type) {
    case "booted":
      return `${event.designation} of ${event.domainName} came online: a ${rules.architectures[event.architecture].name} mind.`;
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
  }
}
