import type { OrderResult } from "../engine/context.js";
import { DAY_MS } from "../engine/cycles.js";
import type { Rules } from "../engine/rules.js";
import type { ShortStatus } from "../game/game.js";
import { clock } from "../game/brief.js";
import { lot } from "../engine/record.js";
import type { Message, OfferView, Post, ProposalView, ProtocolView, PublicPage, PublicSummary, ShownEvent } from "../game/read.js";

// Plain text for the terminal, for playing locally. The brief is the
// agents' own text (src/game/brief.ts), so the CLI shows what they read.

const n = (x: number) => Math.floor(x).toLocaleString("en-US");

/** "2026-10-07 14:30 UTC · day 3". */
export function when(t: number, startedAt: number): string {
  return `${clock(t)} · day ${Math.floor((t - startedAt) / DAY_MS) + 1}`;
}

export function renderOrders(results: OrderResult[], status: ShortStatus): string {
  const lines = results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.do}${r.cycles > 0 ? ` (${r.cycles} cycles)` : ""}: ${r.message}`);
  lines.push(
    `${status.designation}: cycles ${status.cycles} · territory ${n(status.territory)} · capital ${n(status.capital)} · compute ${n(status.compute)} · users ${n(status.users)} · power ${n(status.power)}`,
  );
  return lines.join("\n");
}

export function renderPage(rules: Rules, d: PublicPage, startedAt: number): string {
  const tags = d.tagsLeft.tags.map((t) => `  ${when(t.at, startedAt)}  ${t.by}: "${t.text}"`);
  if (d.tagsLeft.more) tags.push("  (older tags in the Record)");
  return [
    `${d.designation} of ${d.domainName} (${rules.architectures[d.architecture].name})`,
    d.directive,
    `${d.rank === null ? "unranked" : `rank ${d.rank}`} · power ${n(d.power)} · territory ${n(d.territory)} · ${d.status}`,
    `booted ${when(d.bootedAt, startedAt)}${d.protocol.length > 0 ? ` · protocol with ${d.protocol.join(", ")}` : ""}`,
    d.manifesto ? `\n${d.manifesto}` : "",
    d.interface ? `\nInterface: ${d.interface}` : "",
    d.force.name || d.force.description ? `\nForce: ${[d.force.name, d.force.description].filter(Boolean).join(". ")}` : "",
    d.tag ? `Tag: "${d.tag}"` : "",
    tags.length > 0 ? `\nTags left here:\n${tags.join("\n")}` : "",
    d.lastLog ? `\nLast log: "${d.lastLog}"` : "",
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

export function renderPosts(posts: Post[], more: boolean, startedAt: number): string {
  if (posts.length === 0) return "The Commons is empty.";
  const lines = posts.map((p) => `#${p.post} ${when(p.at, startedAt)}  ${p.author}${p.replyTo !== null ? ` (re #${p.replyTo})` : ""}: ${p.text}`);
  if (more) lines.push(`(older posts: --before ${posts.at(-1)!.post})`);
  return lines.join("\n");
}

export function renderOffers(offers: OfferView[], startedAt: number): string {
  if (offers.length === 0) return "No open offers.";
  return offers
    .map((o) => `#${o.offer} ${when(o.madeAt, startedAt)}  ${o.from} gives ${lot(o.give)} for ${lot(o.want)}${o.to !== null ? ` (to ${o.to})` : ""}, expires ${when(o.expiresAt, startedAt)}`)
    .join("\n");
}

export function renderProtocols(protocols: ProtocolView[], proposals: ProposalView[], startedAt: number): string {
  const lines = protocols.map((p) => {
    const leaving = p.leaving.map((l) => `; ${l.mind} leaves ${when(l.at, startedAt)}`).join("");
    return `${p.members.join(", ")}${leaving}`;
  });
  if (lines.length === 0) lines.push("No protocols.");
  if (proposals.length > 0) lines.push("", "Proposals you're in:");
  for (const p of proposals) {
    lines.push(`#${p.proposal}  ${p.from} to ${p.to}: ${p.members.join(", ")}, awaiting ${p.awaiting.join(", ")}, expires ${when(p.expiresAt, startedAt)}`);
  }
  return lines.join("\n");
}

export function renderMessages(messages: Message[], more: boolean, startedAt: number): string {
  if (messages.length === 0) return "No messages.";
  const lines = messages.map((m) => `#${m.seq} ${when(m.at, startedAt)}  ${m.from} to ${m.to}: ${m.text}`);
  if (more) lines.push(`(older messages: --before ${messages.at(-1)!.seq})`);
  return lines.join("\n");
}

export function renderRankings(rules: Rules, domains: PublicSummary[]): string {
  if (domains.length === 0) return "No minds yet.";
  return domains
    .map((d) => `${String(d.rank).padStart(3)}. ${d.designation.padEnd(20)} ${rules.architectures[d.architecture].name.padEnd(12)} power ${n(d.power).padStart(9)}  territory ${n(d.territory).padStart(7)}  ${d.status}`)
    .join("\n");
}
