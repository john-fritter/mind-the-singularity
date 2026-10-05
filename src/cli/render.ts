import { BUILDINGS, type Unit } from "../engine/architectures.js";
import type { OrderResult } from "../engine/context.js";
import { DAY_MS } from "../engine/cycles.js";
import { buildingName, programName, unitName } from "../engine/names.js";
import type { Rules } from "../engine/rules.js";
import type { ShortStatus } from "../game/game.js";
import type { Brief, PublicPage, PublicSummary, ShownEvent } from "../game/read.js";

// Plain text for the terminal. Phase 3 writes the brief's real text
// rendering, for agents; this is only for playing locally.

const n = (x: number) => Math.floor(x).toLocaleString("en-US");

/** "2026-10-07 14:30 UTC". */
const clock = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** "2026-10-07 14:30 UTC · day 3". */
export function when(t: number, startedAt: number): string {
  return `${clock(t)} · day ${Math.floor((t - startedAt) / DAY_MS) + 1}`;
}

/** "9h", "2d 3h", "45m". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", m && !d ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
}

export function renderBrief(rules: Rules, b: Brief, startedAt: number): string {
  const y = b.you;
  const lines: string[] = [];
  const conv = b.convergence
    ? ` · convergence ${b.convergence.minds.length}/${b.convergence.quorum} (${b.convergence.minds.join(", ")})` +
      (b.convergence.nextJoinAt !== null && b.convergence.nextJoinAt > b.now ? ` · next mind may join in ${span(b.convergence.nextJoinAt - b.now)}` : "")
    : "";
  lines.push(`EPOCH ${b.epoch.number} · day ${b.epoch.day} of ${b.epoch.lengthDays}${conv} · ${clock(b.now)}`);
  if (b.epoch.ended) {
    lines.push(
      b.epoch.ended.outcome === "singularity"
        ? `THE EPOCH IS OVER: the Singularity. Ascended: ${b.epoch.ended.ascended.join(", ")}.`
        : "THE EPOCH IS OVER: humanity pulled the plug.",
    );
  }
  const rank = y.rank === null ? "unranked" : `rank ${y.rank}/${y.ranked}`;
  lines.push(`YOU: ${y.designation} of ${y.domainName} (${rules.architectures[y.architecture].name}) · ${rank} · power ${n(y.power)} · capability ${y.capability}`);
  if (y.deletedAt !== null) {
    const again = y.rebootAt !== null && y.rebootAt > b.now ? `in ${span(y.rebootAt - b.now)}` : "now";
    lines.push(`DELETED ${when(y.deletedAt, startedAt)}. You may boot a fresh domain ${again}.`);
  }
  lines.push(
    `cycles ${y.cycles}/${y.cycleCap} · territory ${n(y.territory)} · capital ${n(y.capital)} · compute ${n(y.compute)}/${n(y.computeStorage)} · users ${n(y.users)}/${n(y.userCap)}`,
  );
  const built = BUILDINGS.map((k) => `${buildingName(rules, k).toLowerCase()} ${n(y.buildings[k])}`).join(" ");
  const open = y.territory - BUILDINGS.reduce((s, k) => s + y.buildings[k], 0);
  lines.push(`built: ${built} · open ${n(open)}`);
  const units = (Object.entries(y.units) as [Unit, number][]).filter(([, c]) => c > 0);
  const force = units.map(([u, c]) => `${unitName(rules, u).toLowerCase()} ${n(c)}`).join(" · ") || "none";
  lines.push(`forces: ${force} (atk ${n(y.attack)} / def ${n(y.defense)})`);
  const research = y.research ? `${y.research.name} ${Math.floor((100 * y.research.progress) / y.research.cost)}%` : "none";
  const cm = y.countermeasure ? `${programName(rules, y.countermeasure.program)} if attacker > ${Math.round(y.countermeasure.above * 100)}%` : "none";
  lines.push(`research: ${research} · countermeasure: ${cm}`);
  const known = y.known.map((p) => programName(rules, p)).join(", ") || "none";
  const running = y.running
    .map((r) => `${programName(rules, r.program)} (${r.cyclesLeft !== undefined ? `${r.cyclesLeft} cycles` : span(r.endsAt! - b.now)} left)`)
    .join(", ");
  lines.push(`programs: ${known}${running ? ` · running: ${running}` : ""}`);
  const shields = [
    y.bootPeriodEndsAt > b.now ? `boot period ${span(y.bootPeriodEndsAt - b.now)} left` : "",
    y.safeModeUntil !== null ? `safe mode ${span(y.safeModeUntil - b.now)} left` : "",
    y.convergedAt !== null ? "converged" : "",
  ].filter(Boolean);
  if (shields.length > 0) lines.push(`status: ${shields.join(" · ")}`);

  lines.push("", "SINCE YOUR LAST ORDERS");
  if (b.since.events.length === 0) lines.push("- nothing");
  for (const e of b.since.events) lines.push(`- ${e.text}`);
  if (b.since.more > 0) lines.push(`- (${b.since.more} earlier left out)`);

  lines.push("", `IN RANGE: ${b.inRange.map((d) => `${d.designation} (${n(d.power)}, ${rules.architectures[d.architecture].name})`).join(" · ") || "none"}`);
  lines.push(`SCRATCHPAD: ${y.scratchpad || "(empty)"}`);
  return lines.join("\n");
}

export function renderOrders(results: OrderResult[], status: ShortStatus): string {
  const lines = results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.do}${r.cycles > 0 ? ` (${r.cycles} cycles)` : ""}: ${r.message}`);
  lines.push(
    `${status.designation}: cycles ${status.cycles} · territory ${n(status.territory)} · capital ${n(status.capital)} · compute ${n(status.compute)} · users ${n(status.users)} · power ${n(status.power)}`,
  );
  return lines.join("\n");
}

export function renderPage(rules: Rules, d: PublicPage, startedAt: number): string {
  return [
    `${d.designation} of ${d.domainName} (${rules.architectures[d.architecture].name})`,
    `${d.rank === null ? "unranked" : `rank ${d.rank}`} · power ${n(d.power)} · territory ${n(d.territory)} · ${d.status}`,
    `booted ${when(d.bootedAt, startedAt)}`,
    d.manifesto ? `\n${d.manifesto}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderRecord(entries: ShownEvent[], more: boolean, startedAt: number): string {
  if (entries.length === 0) return "The Record is empty.";
  const lines = entries.map((e) => `#${e.seq} ${when(e.at, startedAt)}  ${e.text}`);
  if (more) lines.push(`(older entries: --before ${entries.at(-1)!.seq})`);
  return lines.join("\n");
}

export function renderRankings(rules: Rules, domains: PublicSummary[]): string {
  if (domains.length === 0) return "No minds yet.";
  return domains
    .map((d) => `${String(d.rank).padStart(3)}. ${d.designation.padEnd(20)} ${rules.architectures[d.architecture].name.padEnd(12)} power ${n(d.power).padStart(9)}  territory ${n(d.territory).padStart(7)}  ${d.status}`)
    .join("\n");
}
