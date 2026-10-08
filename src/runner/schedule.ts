import { createHash } from "node:crypto";
import { parseWindow } from "./tunables.js";

/**
 * When bots wake (phase 6b). A bot's waking window, read in the runner's
 * timezone, is cut into `wakes_per_day` equal slots, and the bot wakes once
 * in each, at a minute drawn from its name, the day and the slot. The draw
 * is a hash, not a stored time, so a restarted runner knows every wake
 * time without keeping any: what it keeps is which slots ran
 * (mind.runner_runs). A slot that falls due while the runner is down is
 * skipped, not caught up, as with the scripted players.
 */

const MINUTE = 60_000;

/** A local calendar day, "2026-10-07". */
export type Day = string;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The local wall clock at `at` in `timeZone`, as if it were UTC. */
function wallClock(at: number, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), Number(parts["hour"]), Number(parts["minute"]), Number(parts["second"]));
}

/** The local day at `at`. */
export function dayOf(at: number, timeZone: string): Day {
  return new Date(wallClock(at, timeZone)).toISOString().slice(0, 10);
}

/** The day after. */
export function nextDay(day: Day): Day {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * MINUTE).toISOString().slice(0, 10);
}

/**
 * The instant of `minutes` after local midnight on `day`. The zone's offset
 * is taken at that moment's UTC reading, and once more after correcting, so
 * a daylight-saving day is at most an hour out around the change itself.
 */
export function localTime(day: Day, minutes: number, timeZone: string): number {
  const asUtc = Date.parse(`${day}T00:00:00Z`) + minutes * MINUTE;
  let at = asUtc - (wallClock(asUtc, timeZone) - asUtc);
  at = asUtc - (wallClock(at, timeZone) - at);
  return at;
}

/** Local midnight at the start of the day after `at`'s: when the budget resets. */
export function nextMidnight(at: number, timeZone: string): number {
  return localTime(nextDay(dayOf(at, timeZone)), 0, timeZone);
}

/** A fraction in [0, 1) from the text, the same on every run. */
function draw(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0) / 2 ** 32;
}

export interface Schedule {
  wakes_per_day: number;
  window: string;
}

/** The bot's wake times on `day`, slot by slot. */
export function wakeTimes(bot: string, s: Schedule, day: Day, timeZone: string): number[] {
  const w = parseWindow(s.window);
  if (!w) throw new Error(`${bot}: "${s.window}" isn't a waking window.`);
  const every = (w.end - w.start) / s.wakes_per_day;
  return Array.from({ length: s.wakes_per_day }, (_, slot) => {
    const minute = Math.floor(w.start + slot * every + draw(`${bot}|${day}|${slot}`) * every);
    return localTime(day, minute, timeZone);
  });
}

/** The bot's next wake after `at` that isn't in `done` (today's run slots), looking into tomorrow. */
export function nextWake(bot: string, s: Schedule, at: number, timeZone: string, done: Set<number> = new Set()): { day: Day; slot: number; at: number } {
  const today = dayOf(at, timeZone);
  const times = wakeTimes(bot, s, today, timeZone);
  const slot = times.findIndex((t, i) => t > at && !done.has(i));
  if (slot !== -1) return { day: today, slot, at: times[slot]! };
  const tomorrow = nextDay(today);
  return { day: tomorrow, slot: 0, at: wakeTimes(bot, s, tomorrow, timeZone)[0]! };
}
