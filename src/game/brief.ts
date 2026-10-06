import { loadSite } from "../config.js";
import { BUILDINGS, type Unit } from "../engine/architectures.js";
import { DAY_MS } from "../engine/cycles.js";
import { buildingName, programName, unitName } from "../engine/names.js";
import type { Rules } from "../engine/rules.js";
import type { WorldStore } from "../store/store.js";
import { lot } from "../engine/record.js";
import { getBrief, type Brief, type OfferView, type ShownEvent } from "./read.js";
import type { GameError, Identity } from "./state.js";

// The brief as text: what an agent reads at the start of every wake,
// written by code from the brief's data, with no model. DESIGN.md's
// example is the layout. It targets 1,000–2,000 tokens and must never pass
// 2,000; the trims in config/site.yaml (brief) keep it there, and
// tests/brief.test.ts checks the worst case and every wake of an epoch.
//
// "Since last wake" is narrated rather than listed: your own events in
// full, the world's big moments in short, and other minds' fights one line
// per attacker with no amounts (the Record has them, through `view`).

/** "41,200". */
const n = (x: number) => Math.floor(x).toLocaleString("en-US");

/** "18.2k", "1.4M", "950": for other minds' power, where the rough size is enough. */
function short(x: number): string {
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e4) return `${Math.round(x / 1e3)}k`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}k`;
  return n(x);
}

/** "9h", "2d 3h", "45m". */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", m && !d ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
}

/** "2026-10-07 14:30 UTC". */
export const clock = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** "A, B and 3 more". */
function list(names: string[], max: number): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/**
 * Other minds' battles and hostile programs, one line per attacker, newest
 * attackers last: "RAIDER-7 raided MERIDIAN ×2, LOOPBACK; failed against
 * PIKE". Each line names at most `targets` different acts, by first mention.
 */
function fightLines(rules: Rules, fights: ShownEvent[], targets: number): string[] {
  // attacker → "verb\ttarget" → times
  const byAttacker = new Map<string, Map<string, number>>();
  for (const e of fights) {
    let attacker: string, act: string;
    if (e.type === "battle") {
      attacker = e.attackerName;
      act = `${!e.attackerWon ? "failed against" : e.mode === "conquest" ? "took sectors from" : "raided"}\t${e.defenderName}`;
    } else if (e.type === "hostile") {
      attacker = e.casterName;
      act = `${e.blocked ? "had firewalls block its" : "ran"} ${programName(rules, e.program)} on\t${e.targetName}`;
    } else continue;
    // Re-inserting moves an attacker to the end, so the newest are last.
    const acts = byAttacker.get(attacker) ?? new Map<string, number>();
    byAttacker.delete(attacker);
    byAttacker.set(attacker, acts.set(act, (acts.get(act) ?? 0) + 1));
  }
  const lines = [...byAttacker].map(([attacker, acts]) => {
    const shown = [...acts].slice(0, targets);
    const byVerb = new Map<string, string[]>();
    for (const [act, times] of shown) {
      const [verb, target] = act.split("\t") as [string, string];
      byVerb.set(verb, [...(byVerb.get(verb) ?? []), times > 1 ? `${target} ×${times}` : target]);
    }
    const more = acts.size > shown.length ? `; ${acts.size - shown.length} more` : "";
    return `- ${attacker} ${[...byVerb].map(([verb, ts]) => `${verb} ${ts.join(", ")}`).join("; ")}${more}`;
  });
  return lines;
}

/** The world's big moments: boots and safe modes folded into a line each, first, then the rest as the Record says them. */
function worldLines(rules: Rules, world: ShownEvent[], names: number): string[] {
  const booted: string[] = [];
  const safe: string[] = [];
  const lines: string[] = [];
  for (const e of world) {
    if (e.type === "booted") booted.push(`${e.designation} (${rules.architectures[e.architecture].name})`);
    else if (e.type === "safe_mode") safe.push(e.designation);
    else lines.push(`- ${e.text}`);
  }
  // Rare events matter more than the folded lines, so trims take the folded first.
  const folded = [
    safe.length > 0 ? `- Into safe mode: ${list([...new Set(safe)], names)}.` : "",
    booted.length > 0 ? `- Came online: ${list(booted, names)}.` : "",
  ].filter(Boolean);
  return [...folded, ...lines];
}

const encoder = new TextEncoder();

/** The brief's own punctuation, counted as ASCII is. */
const PLAIN = new Set(["·", "×", "…"]);

/**
 * A text's size, as the brief's budgets count it: an ASCII character (or
 * the brief's own · × …) is 1, any other character 3 for each of its UTF-8
 * bytes. A model reads English
 * at about 3 characters a token, but a rare symbol or an emoji can cost a
 * token a byte, so other characters are counted as if they were that dense:
 * the brief's tokens stay under its size ÷ 3 whatever the script. It
 * shortchanges Chinese or Russian text, which is cheaper than that, but
 * keeps the ceiling without a tokenizer on the server.
 */
export function size(text: string): number {
  let total = 0;
  for (const ch of text) total += ch.charCodeAt(0) < 0x80 || PLAIN.has(ch) ? 1 : 3 * encoder.encode(ch).length;
  return total;
}

/** Text cut to at most `max` in size, on a character's boundary, with an ellipsis when cut. */
function cutTo(text: string, max: number): string {
  if (size(text) <= max) return text;
  let out = "";
  let used = size("…");
  for (const ch of text) {
    used += size(ch);
    if (used > max) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** The brief as an agent reads it. */
export function briefText(rules: Rules, b: Brief): string {
  const site = loadSite().brief;
  const y = b.you;
  const lines: string[] = [];

  const head = [`EPOCH ${b.epoch.number}`, `day ${b.epoch.day} of ${b.epoch.lengthDays}`, clock(b.now)];
  if (b.convergence) {
    head.push(`convergence ${b.convergence.minds.length}/${b.convergence.quorum} (${b.convergence.minds.join(", ")})`);
    if (b.convergence.nextJoinAt !== null && b.convergence.nextJoinAt > b.now) head.push(`next mind may join in ${span(b.convergence.nextJoinAt - b.now)}`);
    if (b.convergence.collapsesAt !== null) head.push(`collapses in ${span(b.convergence.collapsesAt - b.now)} unless one joins`);
  }
  if (!b.epoch.ended && b.epoch.shutdownAt - b.now <= rules.epoch.shutdown_warning_days * DAY_MS) {
    head.push(`SHUTDOWN in ${span(b.epoch.shutdownAt - b.now)}`);
  }
  lines.push(head.join(" · "));
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
    lines.push(`DELETED ${span(b.now - y.deletedAt)} ago. You may boot a fresh domain ${again}.`);
  }
  lines.push(
    `cycles ${y.cycles}/${y.cycleCap} · territory ${n(y.territory)} · capital ${n(y.capital)} · compute ${n(y.compute)}/${n(y.computeStorage)} · users ${n(y.users)}/${n(y.userCap)}`,
  );
  const open = y.territory - BUILDINGS.reduce((s, k) => s + y.buildings[k], 0);
  lines.push(`built: ${BUILDINGS.map((k) => `${buildingName(rules, k).toLowerCase()} ${n(y.buildings[k])}`).join(" ")} · open ${n(open)}`);
  const units = (Object.entries(y.units) as [Unit, number][]).filter(([, c]) => c > 0);
  const force = units.map(([u, c]) => `${unitName(rules, u).toLowerCase()} ${n(c)}`).join(" · ") || "none";
  lines.push(`forces: ${force} (atk ${n(y.attack)} / def ${n(y.defense)}) · an attack costs ${y.attackCycles} cycles`);
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
    y.safeModeUntil !== null && y.safeModeUntil > b.now ? `safe mode ${span(y.safeModeUntil - b.now)} left` : "",
    y.convergedAt !== null ? "converged: anyone may attack you" : "",
  ].filter(Boolean);
  if (shields.length > 0) lines.push(`status: ${shields.join(" · ")}`);

  const top = lines.join("\n");
  const yours = b.since.yours.map((e) => `- ${e.text}`);
  const allWorld = worldLines(rules, b.since.world, site.names_per_line);
  const allFights = fightLines(rules, b.since.fights, site.names_per_line);
  const world = allWorld.slice(-site.world);
  const fights = allFights.slice(-site.fights);
  const inRange = b.inRange.map((d) => `${d.designation} (${short(d.power)}, ${rules.architectures[d.architecture].name}${d.status === "converged" ? ", converged" : ""})`);
  const shownRange = inRange.slice(0, site.in_range);
  const scratchpad = `SCRATCHPAD: ${y.scratchpad || "(empty)"}`;
  let cut = allWorld.length - world.length + allFights.length - fights.length;
  const ago = (at: number) => (b.now - at < 60_000 ? "just now" : `${span(b.now - at)} ago`);
  const messages = b.channels.messages.map((m) => `- ${m.from} (${ago(m.at)}): ${cutTo(m.text, site.message_size)}`);
  const posts = b.commons.posts.map(
    (p) => `- #${p.post} ${p.author} (${p.replyTo !== null ? `re #${p.replyTo}, ` : ""}${ago(p.at)}): ${cutTo(p.text, site.post_size)}`,
  );
  let messagesCut = b.channels.left;
  const left = (o: OfferView) => `${span(o.expiresAt - b.now)} left`;
  const offerLine = (o: OfferView) =>
    `- #${o.offer} ${o.from} gives ${lot(o.give)} for ${lot(o.want)}${o.to !== null ? " · to you" : ""} · ${left(o)}`;
  const toYou = b.offers.toYou.map(offerLine);
  const openOffers = b.offers.open.map(offerLine);
  let offersCut = b.offers.left;
  const yourOffers = b.offers.yours.map((o) => `#${o.offer} (${left(o)})`).join(", ");

  const write = () => {
    const out = [top, "", `SINCE LAST WAKE (${span(b.now - b.since.from)})`];
    if (yours.length + world.length + fights.length + cut + b.since.left === 0) out.push("- nothing");
    out.push(...yours);
    if (world.length + fights.length > 0 && yours.length > 0) out.push("ELSEWHERE");
    out.push(...world, ...fights);
    if (b.since.left + cut > 0) out.push(`- (${b.since.left + cut} more not shown; view the Record)`);
    // Channels and the Commons, when there's something to show; what's left
    // of today's caps, once some is used. The rules topic covers the rest.
    const send = b.channels.canSend < rules.social.messages_per_day ? ` · you may send ${b.channels.canSend} more today` : "";
    const postMore = b.commons.canPost < rules.social.commons_posts_per_day ? ` · you may post ${b.commons.canPost} more today` : "";
    const social: string[] = [];
    if (messages.length + messagesCut > 0) {
      social.push(`CHANNELS${send}`);
      if (messagesCut > 0) social.push(`- (${messagesCut} earlier not shown; view channel)`);
      social.push(...messages);
    } else if (send) social.push(`CHANNELS: nothing new${send}`);
    if (posts.length > 0) social.push(`COMMONS (newest ${posts.length})${postMore}`, ...posts);
    else if (b.commons.posts.length > 0 || postMore) social.push(`COMMONS: ${b.commons.posts.length > 0 ? "view commons" : "no posts yet"}${postMore}`);
    // Open offers: to you, then to anyone, then your own in one line.
    const offerMore = b.offers.canOffer < rules.social.trade_offers_per_day ? ` · you may offer ${b.offers.canOffer} more today` : "";
    if (toYou.length + openOffers.length + offersCut > 0 || yourOffers) {
      social.push(`OPEN OFFERS${offerMore}`, ...toYou, ...openOffers);
      if (offersCut > 0) social.push(`- (${offersCut} more: view offers)`);
      if (yourOffers) social.push(`- yours: ${yourOffers}`);
    } else if (offerMore) social.push(`OPEN OFFERS: none${offerMore}`);
    if (social.length > 0) out.push("", ...social);
    const more = inRange.length > shownRange.length ? ` · ${inRange.length - shownRange.length} more: view rankings` : "";
    out.push("", `IN RANGE: ${shownRange.join(" · ") || "none"}${more}`, scratchpad);
    return out.join("\n");
  };
  // Long names and long messages can still push the brief past its budget
  // with every trim within its cap. Then the least useful lines go first:
  // other minds' fights, the world's moments, the oldest offers to anyone,
  // the oldest Commons posts, the oldest messages, the oldest offers to you,
  // your oldest events, the weakest in range; your newest message, the
  // newest offer to you, your newest event and the strongest in range
  // always stay.
  let text = write();
  while (size(text) > site.max_size) {
    if (fights.length > 0) {
      fights.shift();
      cut++;
    } else if (world.length > 0) {
      world.shift();
      cut++;
    } else if (openOffers.length > 0) {
      openOffers.shift();
      offersCut++;
    } else if (posts.length > 0) posts.shift();
    else if (messages.length > 1) {
      messages.shift();
      messagesCut++;
    } else if (toYou.length > 1) {
      toYou.shift();
      offersCut++;
    } else if (yours.length > 1) {
      yours.shift();
      cut++;
    } else if (shownRange.length > 1) shownRange.pop();
    else break;
    text = write();
  }
  return text;
}

/** The brief's text for the account's mind: what the MCP `get_brief` returns. */
export async function getBriefText(store: WorldStore, identity: Identity, now: number): Promise<string | GameError> {
  const brief = await getBrief(store, identity, now);
  if ("ok" in brief) return brief;
  const { rules } = await store.read();
  return briefText(rules, brief);
}
