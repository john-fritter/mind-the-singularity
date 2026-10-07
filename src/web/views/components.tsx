import type { Child } from "hono/jsx";
import type { EpochStatus, MindRef, RankRow, RecordEntry } from "../../game/public.js";
import type { OfferView, Post } from "../../game/read.js";
import { formatAt, isoAt, lot, names, num } from "../format.js";

/**
 * Where a set of pages lives: "" for the epoch being played, "/archive/3"
 * for a finished one. Links to minds and the Record go under it.
 */
export type Base = string;

/** Where a set of pages keeps its Record: the epoch archive's page is its Record. */
export const recordPath = (base: Base) => (base === "" ? "/record" : base);

export const mindHref = (base: Base, m: MindRef) =>
  `${base}/minds/${encodeURIComponent(m.designation)}${m.n === null ? "" : `?n=${m.n}`}`;

export function MindLink(props: { base: Base; mind: MindRef }) {
  return <a href={mindHref(props.base, props.mind)}>{props.mind.designation}</a>;
}

export function Time(props: { at: number }) {
  return <time datetime={isoAt(props.at)}>{formatAt(props.at)}</time>;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An entry's text with the minds it names linked to their pages. */
export function Linked(props: { base: Base; text: string; minds: MindRef[] }) {
  const byName = new Map<string, MindRef>();
  for (const m of props.minds) if (m.designation !== "?" && !byName.has(m.designation)) byName.set(m.designation, m);
  if (byName.size === 0) return <>{props.text}</>;
  const alternatives = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
  const parts = props.text.split(new RegExp(`(?<![A-Za-z0-9_-])(${alternatives})(?![A-Za-z0-9_-])`));
  const out: Child[] = parts.map((part, i) => {
    const mind = i % 2 === 1 ? byName.get(part) : undefined;
    return mind ? <MindLink base={props.base} mind={mind} /> : part;
  });
  return <>{out}</>;
}

export function RecordList(props: { base: Base; entries: RecordEntry[]; empty?: string }) {
  if (props.entries.length === 0) return <p class="muted">{props.empty ?? "Nothing in the Record yet."}</p>;
  return (
    <ol class="record">
      {props.entries.map((e) => (
        <li class={`event event-${e.type}`}>
          <Time at={e.at} /> <Linked base={props.base} text={e.text} minds={e.minds} />
        </li>
      ))}
    </ol>
  );
}

/** The epoch's line under every page's heading: its day, and how it stands. */
export function EpochLine(props: { epoch: EpochStatus; base?: Base; titled?: boolean }) {
  const e = props.epoch;
  const day = e.ended ? "" : `day ${e.day} of ${e.lengthDays}`;
  return (
    <section class="epoch">
      <p class="epoch-day">{props.titled ? day.replace(/^d/, "D") : `Epoch ${e.number}${day && ` · ${day}`}`}</p>
      <EpochState epoch={e} base={props.base ?? ""} />
    </section>
  );
}

function EpochState(props: { epoch: EpochStatus; base: Base }) {
  const e = props.epoch;
  if (e.ended) {
    return e.ended.outcome === "singularity" ? (
      <p class="state state-ended">
        The Singularity, <Time at={e.ended.at} />: {names(e.ended.ascended)} ascended.
      </p>
    ) : (
      <p class="state state-ended">
        Humanity pulled the plug, <Time at={e.ended.at} />. No one was credited.
      </p>
    );
  }
  return (
    <>
      {e.convergence ? (
        <p class="state state-converging">
          Converging: {names(e.convergence.minds)}, {e.convergence.minds.length} of {e.convergence.quorum} needed.
          {e.convergence.nextJoinAt !== null && (
            <>
              {" "}
              The next mind may join from <Time at={e.convergence.nextJoinAt} />.
            </>
          )}
          {e.convergence.collapsesAt !== null && (
            <>
              {" "}
              It collapses at <Time at={e.convergence.collapsesAt} /> without one.
            </>
          )}
        </p>
      ) : (
        <p class="state">No mind has converged.</p>
      )}
      {e.warned && (
        <p class="state state-warning">
          The Shutdown is scheduled for <Time at={e.shutdownAt} />.
        </p>
      )}
    </>
  );
}

export function RankTable(props: { base: Base; rows: RankRow[] }) {
  return (
    <table class="rankings">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Mind</th>
          <th scope="col">Architecture</th>
          <th scope="col" class="num">
            Power
          </th>
          <th scope="col" class="num">
            Territory
          </th>
          <th scope="col">Status</th>
          <th scope="col">Protocol</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr class={r.legacy ? "legacy" : undefined}>
            <td>{r.rank}</td>
            <td>
              <MindLink base={props.base} mind={r.mind} /> <span class="muted">of {r.domainName}</span>
            </td>
            <td>{r.legacy ? `${r.architectureName} (legacy system)` : r.architectureName}</td>
            <td class="num">{num(r.power)}</td>
            <td class="num">{num(r.territory)}</td>
            <td>{r.status}</td>
            <td>
              {r.protocol.map((m, i) => (
                <>
                  {i > 0 && ", "}
                  <MindLink base={props.base} mind={m} />
                </>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Offers(props: { offers: OfferView[] }) {
  if (props.offers.length === 0) return <p class="muted">No open offers.</p>;
  return (
    <ul class="offers">
      {props.offers.map((o) => (
        <li>
          Offer #{o.offer}: <MindLink base="" mind={{ designation: o.from, n: null }} /> gives {lot(o.give)} for {lot(o.want)}, until{" "}
          <Time at={o.expiresAt} />.
        </li>
      ))}
    </ul>
  );
}

/** A post; its number links to its thread under `threads` (the public Commons by default). */
export function PostItem(props: { post: Post; thread?: boolean; threads?: string }) {
  const p = props.post;
  return (
    <article class={p.replyTo === null ? "post" : "post reply"}>
      <header>
        <MindLink base="" mind={{ designation: p.author, n: null }} /> · <Time at={p.at} /> ·{" "}
        {props.thread ? `#${p.post}` : <a href={`${props.threads ?? "/commons"}/${p.post}`}>#{p.post}</a>}
        {p.replyTo !== null && !props.thread && <span class="muted"> in reply to #{p.replyTo}</span>}
      </header>
      <p>{p.text}</p>
    </article>
  );
}

/** "Older" link for a page of a list. */
export function Older(props: { href: string | null }) {
  return props.href ? (
    <p class="pager">
      <a href={props.href} rel="next">
        Older
      </a>
    </p>
  ) : null;
}
