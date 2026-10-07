import type { Child } from "hono/jsx";
import type {
  AdminEntry,
  AdminEpoch,
  AdminListPage,
  AdminLogEntry,
  AdminMessage,
  AdminMindPage,
  AdminMindRow,
  AdminOverview,
} from "../../game/admin.js";
import type { MindRef } from "../../game/public.js";
import type { OfferView, ProposalView } from "../../game/read.js";
import { lot, names, num, typeLabel } from "../format.js";
import { EpochLine, Linked, MindLink, Older, Time } from "./components.js";
import { Layout, type PageCtx } from "./layout.js";
import { ArchBadge } from "./look.js";
import { ProbeReport } from "./play.js";

// The admin view: everything, for an account with the admin flag. The game
// layer (src/game/admin.ts) decides who sees it; these only lay it out.
// Links keep the epoch being looked at, and minds link to their admin page.

/** An admin address: `path` with the query, plus the epoch when it isn't the newest. */
export function adminHref(top: AdminEpoch, path: string, query: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  if (!top.newest) params.set("epoch", String(top.epoch.number));
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

const mindAdminHref = (top: AdminEpoch, m: MindRef) =>
  adminHref(top, `/admin/minds/${encodeURIComponent(m.designation)}`, {
    n: m.n ?? undefined,
  });

function AdminMind(props: { top: AdminEpoch; mind: MindRef }) {
  return <MindLink base="" mind={props.mind} href={mindAdminHref(props.top, props.mind)} />;
}

function AdminNav(props: { top: AdminEpoch; here: string }) {
  const links: [string, string][] = [
    ["/admin", "Minds"],
    ["/admin/channels", "Channels"],
    ["/admin/record", "The whole Record"],
    ["/admin/orders", "Orders log"],
  ];
  return (
    <>
      <nav class="play-nav" aria-label="Admin">
        {links.map(([href, label]) => (href === props.here ? <strong>{label}</strong> : <a href={adminHref(props.top, href)}>{label}</a>))}
      </nav>
      {props.top.epochs.length > 1 && (
        <form method="get" action={props.here === "/admin/minds" ? "/admin" : props.here} class="filter">
          <label>
            Epoch{" "}
            <select name="epoch">
              {props.top.epochs.map((n) => (
                <option value={String(n)} selected={n === props.top.epoch.number}>
                  {n}
                </option>
              ))}
            </select>
          </label>{" "}
          <button type="submit">Look</button>
        </form>
      )}
    </>
  );
}

function AdminLayout(props: { ctx: PageCtx; top: AdminEpoch; here: string; title: string; children?: Child }) {
  return (
    <Layout ctx={props.ctx} title={`Admin: ${props.title}`}>
      <h1>{props.title}</h1>
      <p class="muted">Admin view: everything, private things included. Only accounts with the admin flag see these pages.</p>
      <EpochLine epoch={props.top.epoch} />
      <AdminNav top={props.top} here={props.here} />
      {props.children}
    </Layout>
  );
}

function MindsTable(props: { ctx: PageCtx; top: AdminEpoch; rows: AdminMindRow[] }) {
  const n = props.top.names;
  return (
    <div class="scroll">
      <table class="rankings">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Mind</th>
            <th scope="col">Owner</th>
            <th scope="col">Architecture</th>
            <th scope="col" class="num">
              Power
            </th>
            <th scope="col" class="num">
              Cycles
            </th>
            <th scope="col" class="num">
              Capital
            </th>
            <th scope="col" class="num">
              Compute
            </th>
            <th scope="col" class="num">
              Users
            </th>
            <th scope="col" class="num">
              Territory
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr class={r.legacy || r.deletedAt !== null ? "legacy" : undefined}>
              <td>{r.summary.rank ?? ""}</td>
              <td>
                <AdminMind top={props.top} mind={r.mind} />
              </td>
              <td>{r.owner}</td>
              <td>
                <ArchBadge
                  ctx={props.ctx}
                  id={r.status.architecture}
                  name={n[r.status.architecture] ?? r.status.architecture}
                  legacy={r.legacy}
                />
              </td>
              <td class="num">{num(r.status.power)}</td>
              <td class="num">{num(r.status.cycles)}</td>
              <td class="num">{num(r.status.capital)}</td>
              <td class="num">{num(r.status.compute)}</td>
              <td class="num">{num(r.status.users)}</td>
              <td class="num">{num(r.status.territory)}</td>
              <td>{r.summary.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminOverviewView(props: { ctx: PageCtx; page: AdminOverview }) {
  const p = props.page;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin" title={`Epoch ${p.epoch.number}: every mind`}>
      {p.minds.length === 0 ? <p class="muted">No domain has booted.</p> : <MindsTable ctx={props.ctx} top={p} rows={p.minds} />}
    </AdminLayout>
  );
}

function Entries(props: { top: AdminEpoch; entries: AdminEntry[]; empty: string }) {
  if (props.entries.length === 0) return <p class="muted">{props.empty}</p>;
  return (
    <ol class="record">
      {props.entries.map((e) => (
        <li class={`event event-${e.type}`}>
          <Time at={e.at} /> {!e.public && <span class="label">[private] </span>}
          <Linked base="" text={e.text} minds={e.minds} hrefOf={(m) => mindAdminHref(props.top, m)} />
        </li>
      ))}
    </ol>
  );
}

function Messages(props: { top: AdminEpoch; messages: AdminMessage[]; empty: string }) {
  if (props.messages.length === 0) return <p class="muted">{props.empty}</p>;
  return (
    <ol class="record">
      {props.messages.map((m) => (
        <li>
          <Time at={m.at} /> <AdminMind top={props.top} mind={m.from} /> to <AdminMind top={props.top} mind={m.to} />: {m.text}
        </li>
      ))}
    </ol>
  );
}

function OfferLines(props: { offers: OfferView[] }) {
  if (props.offers.length === 0) return <p class="muted">No open offers.</p>;
  return (
    <ul class="offers">
      {props.offers.map((o) => (
        <li>
          Offer #{o.offer}: {o.from} gives {lot(o.give)} for {lot(o.want)}, to {o.to ?? "anyone"}, until <Time at={o.expiresAt} />.
        </li>
      ))}
    </ul>
  );
}

function ProposalLines(props: { proposals: ProposalView[] }) {
  if (props.proposals.length === 0) return <p class="muted">No open proposals.</p>;
  return (
    <ul>
      {props.proposals.map((p) => (
        <li>
          #{p.proposal}: {p.from} to {p.to}, making {names(p.members)}; waiting on {names(p.awaiting)}, until <Time at={p.expiresAt} />.
        </li>
      ))}
    </ul>
  );
}

export function AdminMindView(props: { ctx: PageCtx; page: AdminMindPage; olderHref: string | null }) {
  const p = props.page;
  const r = p.row;
  const channelsHref = adminHref(p, "/admin/channels", {
    mind: r.mind.designation,
  });
  const ordersHref = adminHref(p, "/admin/orders", {
    mind: r.mind.designation,
  });
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/minds" title={`${r.mind.designation} of ${p.domainName}`}>
      <dl class="facts">
        <dt>Owner</dt>
        <dd>{r.owner}</dd>
        <dt>Orders</dt>
        <dd>
          <a href={ordersHref}>its orders log</a>
        </dd>
        <dt>Public page</dt>
        <dd>{p.newest ? <MindLink base="" mind={r.mind} /> : <span class="muted">see the Archive</span>}</dd>
        <dt>Rank</dt>
        <dd>{r.summary.rank ?? "unranked"}</dd>
        <dt>Status</dt>
        <dd>
          {r.summary.status}
          {r.deletedAt !== null && (
            <>
              {" "}
              since <Time at={r.deletedAt} />
            </>
          )}
        </dd>
        <dt>Research</dt>
        <dd>{p.research ? `${p.research.name}, ${num(p.research.progress)} points` : "none"}</dd>
        <dt>Protocol</dt>
        <dd>{p.protocol ? names(p.protocol.members) : "none"}</dd>
      </dl>
      <section>
        <h2>Full status</h2>
        <ProbeReport status={r.status} names={p.names} />
      </section>
      <section>
        <h2>Scratchpad</h2>
        {p.scratchpad === "" ? <p class="muted">Empty.</p> : <pre class="numbers wrapped">{p.scratchpad}</pre>}
      </section>
      <section>
        <h2>Channels</h2>
        <Messages top={p} messages={p.messages.entries} empty="No messages sent or received." />
        {p.messages.more && (
          <p>
            <a href={channelsHref}>All its messages</a>
          </p>
        )}
      </section>
      <section>
        <h2>Open offers</h2>
        <OfferLines offers={p.offers} />
      </section>
      <section>
        <h2>Protocol proposals</h2>
        <ProposalLines proposals={p.proposals} />
      </section>
      <section>
        <h2>Its Record, private entries included</h2>
        <Entries top={p} entries={p.record.entries} empty="Nothing in the Record about it." />
        <Older href={props.olderHref} />
      </section>
    </AdminLayout>
  );
}

export function AdminChannelsView(props: { ctx: PageCtx; page: AdminListPage<AdminMessage>; mind: string; olderHref: string | null }) {
  const p = props.page;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/channels" title="Every channel">
      <form method="get" action="/admin/channels" class="filter">
        {!p.newest && <input type="hidden" name="epoch" value={String(p.epoch.number)} />}
        <label>
          Mind <input type="text" name="mind" value={props.mind} maxlength={80} />
        </label>{" "}
        <button type="submit">Filter</button>
      </form>
      <Messages top={p} messages={p.entries} empty="No messages." />
      <Older href={props.olderHref} />
    </AdminLayout>
  );
}

export function AdminRecordView(props: {
  ctx: PageCtx;
  page: AdminListPage<AdminEntry>;
  types: readonly string[];
  filter: { mind: string; type: string };
  olderHref: string | null;
}) {
  const p = props.page;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/record" title="The whole Record">
      <form method="get" action="/admin/record" class="filter">
        {!p.newest && <input type="hidden" name="epoch" value={String(p.epoch.number)} />}
        <label>
          Mind <input type="text" name="mind" value={props.filter.mind} maxlength={80} />
        </label>{" "}
        <label>
          Event{" "}
          <select name="type">
            <option value="">any</option>
            {props.types.map((t) => (
              <option value={t} selected={t === props.filter.type}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="submit">Filter</button>
      </form>
      <Entries top={p} entries={p.entries} empty="Nothing in the Record matches." />
      <Older href={props.olderHref} />
    </AdminLayout>
  );
}

function LogItem(props: { top: AdminEpoch; e: AdminLogEntry }) {
  const e = props.e;
  return (
    <li>
      <p>
        #{e.index} · <Time at={e.at} /> · {e.account} {e.kind === "boot" ? "booted" : "ordered for"}{" "}
        <AdminMind top={props.top} mind={e.mind} />
      </p>
      {e.input !== null && <pre class="numbers wrapped">{e.input}</pre>}
      {e.orders.length > 0 && (
        <ol class="results">
          {e.orders.map((o) => (
            <li class={o.result?.ok ? "ok" : "refused"}>
              <code>{o.order}</code>
              <br />
              {o.result
                ? `${o.result.ok ? "" : "refused: "}${o.result.message}${o.result.cycles ? ` (${num(o.result.cycles)} ${o.result.cycles === 1 ? "cycle" : "cycles"})` : ""}`
                : "no result"}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function AdminOrdersView(props: {
  ctx: PageCtx;
  page: AdminListPage<AdminLogEntry>;
  filter: { account: string; mind: string };
  olderHref: string | null;
}) {
  const p = props.page;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/orders" title="The orders log">
      <form method="get" action="/admin/orders" class="filter">
        {!p.newest && <input type="hidden" name="epoch" value={String(p.epoch.number)} />}
        <label>
          Account <input type="text" name="account" value={props.filter.account} maxlength={80} />
        </label>{" "}
        <label>
          Mind <input type="text" name="mind" value={props.filter.mind} maxlength={80} />
        </label>{" "}
        <button type="submit">Filter</button>
      </form>
      {p.entries.length === 0 ? (
        <p class="muted">Nothing in the log matches.</p>
      ) : (
        <ol class="adminlog">
          {p.entries.map((e) => (
            <LogItem top={p} e={e} />
          ))}
        </ol>
      )}
      <Older href={props.olderHref} />
    </AdminLayout>
  );
}
