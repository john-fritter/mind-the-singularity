import type { Child } from "hono/jsx";
import {
  type AdminEntry,
  type AdminEpoch,
  type AdminListPage,
  type AdminLogEntry,
  type AdminMessage,
  type AdminMindPage,
  type AdminMindRow,
  type AdminOverview,
  type AdminSort,
} from "../../game/admin.js";
import type { MindRef } from "../../game/public.js";
import type { OfferView, ProposalView } from "../../game/read.js";
import { formatAt, formatDate, formatShort, isoAt, lot, names, num, typeLabel } from "../format.js";
import { EpochLine, Linked, MindLink, Older, Time } from "./components.js";
import { Layout, type PageCtx } from "./layout.js";
import { ArchBadge } from "./look.js";
import { ProbeReport } from "./play.js";

// The admin view: everything, for an account with the admin flag. The game
// layer (src/game/admin.ts) decides who sees it; these only lay it out.
// Links keep the epoch being looked at, and minds link to their admin page.
// Filters are plain GET forms whose dropdowns list what the epoch holds;
// each log sits in a box a screenful high that scrolls on its own, under
// its filters and download links.

/** A page's filters as given: the query keys that are set. */
export type Filters = Record<string, string | undefined>;

/** An admin address: `path` with the query, plus the epoch when it isn't the newest. */
export function adminHref(top: AdminEpoch | null, path: string, query: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  if (top && !top.newest) params.set("epoch", String(top.epoch.number));
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

const ADMIN_LINKS: [string, string][] = [
  ["/admin", "Minds"],
  ["/admin/channels", "Channels"],
  ["/admin/record", "The whole Record"],
  ["/admin/orders", "Orders log"],
  ["/admin/bots", "Bots"],
  ["/admin/wakes", "Wakes"],
];

/** The admin pages' links, and the epoch picker on the pages that look at one. */
export function AdminNav(props: { top: AdminEpoch | null; here: string }) {
  const top = props.top;
  return (
    <>
      <nav class="play-nav" aria-label="Admin">
        {ADMIN_LINKS.map(([href, label]) => (href === props.here ? <strong>{label}</strong> : <a href={adminHref(top, href)}>{label}</a>))}
      </nav>
      {top && top.epochs.length > 1 && (
        <form method="get" action={props.here === "/admin/minds" ? "/admin" : props.here} class="filter">
          <label>
            Epoch{" "}
            <select name="epoch">
              {top.epochs.map((n) => (
                <option value={String(n)} selected={n === top.epoch.number}>
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
      <p class="muted admin-note">Admin view: everything, private things included. Only accounts with the admin flag see these pages.</p>
      <EpochLine epoch={props.top.epoch} />
      <AdminNav top={props.top} here={props.here} />
      {props.children}
    </Layout>
  );
}

/** A log in a box a screenful high that scrolls on its own; it takes focus so a keyboard can scroll it. */
export function LogBox(props: { label: string; children?: Child }) {
  return (
    <div class="logbox" tabindex={0} role="region" aria-label={props.label}>
      {props.children}
    </div>
  );
}

/** "Download CSV · JSON" for a list, with the filters it's showing (not the page: a download holds every match). */
export function Downloads(props: { href: (ext: "csv" | "json") => string; what: string }) {
  return (
    <p class="downloads">
      Download {props.what}: <a href={props.href("csv")}>CSV</a> · <a href={props.href("json")}>JSON</a>
    </p>
  );
}

/** "312 of 4,810 orders calls match" or "4,810 orders calls"; and how many this page shows. */
export function Count(props: { matched: number; total: number; shown: number; noun: string }) {
  const p = props;
  const all = p.matched === p.total ? `${num(p.total)} ${p.noun}` : `${num(p.matched)} of ${num(p.total)} ${p.noun} match`;
  return (
    <p class="count muted">
      {all}
      {p.shown < p.matched ? `; ${num(p.shown)} on this page, newest first` : ""}.
    </p>
  );
}

const same = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();

/** A dropdown of the epoch's minds, legacy systems and deleted minds marked. */
function MindSelect(props: { top: AdminEpoch; name: string; label: string; value: string | undefined }) {
  return (
    <label>
      {props.label}{" "}
      <select name={props.name}>
        <option value="">any</option>
        {props.top.choices.minds.map((m) => (
          <option value={m.designation} selected={same(props.value, m.designation)}>
            {m.designation}
            {m.legacy ? " (legacy)" : m.deleted ? " (deleted)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A dropdown of the epoch's days so far: "Day 3 (10 Oct)". */
function DaySelect(props: { top: AdminEpoch; value: string | undefined }) {
  return (
    <label>
      Day{" "}
      <select name="day">
        <option value="">any</option>
        {props.top.choices.days.map((d) => (
          <option value={String(d.day)} selected={props.value === String(d.day)}>
            {d.day} ({formatDate(d.at)})
          </option>
        ))}
      </select>
    </label>
  );
}

/** A dropdown of fixed values, "any" first. */
export function Pick(props: { name: string; label: string; value: string | undefined; options: readonly (string | [string, string])[] }) {
  return (
    <label>
      {props.label}{" "}
      <select name={props.name}>
        <option value="">any</option>
        {props.options.map((o) => {
          const [value, text] = typeof o === "string" ? [o, o] : o;
          return (
            <option value={value} selected={same(props.value, value)}>
              {text}
            </option>
          );
        })}
      </select>
    </label>
  );
}

/** A filter form: the dropdowns, Filter, and a link that clears them. */
export function FilterForm(props: { action: string; epoch?: number | null; clear: string; children?: Child }) {
  return (
    <form method="get" action={props.action} class="filter">
      {props.epoch != null && <input type="hidden" name="epoch" value={String(props.epoch)} />}
      {props.children} <button type="submit">Filter</button> <a href={props.clear}>Clear</a>
    </form>
  );
}

/** A list's download links, keeping its filters and its epoch. */
const downloadHref = (top: AdminEpoch, path: string, filters: Filters) => (ext: "csv" | "json") => adminHref(top, `${path}.${ext}`, filters);

function SortLink(props: { top: AdminEpoch; sort: AdminSort; by: AdminSort; children?: Child }) {
  if (props.sort === props.by) return <strong>{props.children}</strong>;
  return <a href={adminHref(props.top, "/admin", { sort: props.by === "rank" ? undefined : props.by })}>{props.children}</a>;
}

function MindsTable(props: { ctx: PageCtx; top: AdminEpoch; rows: AdminMindRow[]; sort: AdminSort }) {
  const n = props.top.names;
  const s = (by: AdminSort, label: string) => (
    <SortLink top={props.top} sort={props.sort} by={by}>
      {label}
    </SortLink>
  );
  return (
    <div class="scroll">
      <table class="rankings">
        <thead>
          <tr>
            <th scope="col">{s("rank", "#")}</th>
            <th scope="col">Mind</th>
            <th scope="col">Owner</th>
            <th scope="col">Architecture</th>
            <th scope="col" class="num">
              {s("power", "Power")}
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
            <th scope="col" class="num">
              {s("orders", "Orders")}
            </th>
            <th scope="col" class="num">
              {s("refused", "Refused")}
            </th>
            <th scope="col">{s("quiet", "Last order")}</th>
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
              <td class="num">{num(r.orders)}</td>
              <td class="num">{num(r.refused)}</td>
              <td class="nowrap">
                {r.lastOrderAt === null ? (
                  <span class="muted">never</span>
                ) : (
                  <time datetime={isoAt(r.lastOrderAt)} title={formatAt(r.lastOrderAt)}>
                    {formatShort(r.lastOrderAt)}
                  </time>
                )}
              </td>
              <td>{r.summary.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SORT_NAMES: Record<AdminSort, string> = {
  rank: "by rank",
  power: "by power",
  orders: "most orders first",
  refused: "most refused orders first",
  quiet: "longest without an order first",
};

export function AdminOverviewView(props: { ctx: PageCtx; page: AdminOverview }) {
  const p = props.page;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin" title={`Epoch ${p.epoch.number}: every mind`}>
      <p class="downloads">
        Download: <a href={adminHref(p, "/admin/minds.csv")}>this table (CSV)</a> ·{" "}
        <a href={adminHref(p, "/admin/epoch.json")}>the whole epoch (JSON: its start, rules and orders log, enough to replay it)</a>
      </p>
      {p.minds.length === 0 ? (
        <p class="muted">No domain has booted.</p>
      ) : (
        <>
          <p class="count muted">
            {p.minds.length} domains, {SORT_NAMES[p.sort]}. Column headers that are links sort the table.
          </p>
          <MindsTable ctx={props.ctx} top={p} rows={p.minds} sort={p.sort} />
        </>
      )}
    </AdminLayout>
  );
}

function Entries(props: { top: AdminEpoch; entries: AdminEntry[]; empty: string }) {
  if (props.entries.length === 0) return <p class="muted">{props.empty}</p>;
  return (
    <ol class="record">
      {props.entries.map((e) => (
        <li class={`event event-${e.type}`} id={`seq-${e.seq}`}>
          <a href={`#seq-${e.seq}`} class="anchor">
            #{e.seq}
          </a>{" "}
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
        <li id={`seq-${m.seq}`}>
          <a href={`#seq-${m.seq}`} class="anchor">
            #{m.seq}
          </a>{" "}
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
  const mind: Filters = { mind: r.mind.designation };
  const channelsHref = adminHref(p, "/admin/channels", mind);
  const ordersHref = adminHref(p, "/admin/orders", mind);
  const recordFilter: Filters = { mind: r.mind.designation, n: r.mind.n === null ? undefined : String(r.mind.n) };
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/minds" title={`${r.mind.designation} of ${p.domainName}`}>
      <dl class="facts">
        <dt>Owner</dt>
        <dd>{r.owner}</dd>
        <dt>Orders</dt>
        <dd>
          <a href={ordersHref}>its orders log</a>: {num(r.orders)} sent, {num(r.refused)} refused
          {r.lastOrderAt !== null && (
            <>
              , the last <Time at={r.lastOrderAt} />
            </>
          )}
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
        {p.scratchpad === "" ? (
          <p class="muted">Empty.</p>
        ) : (
          <LogBox label="Scratchpad">
            <pre class="numbers wrapped">{p.scratchpad}</pre>
          </LogBox>
        )}
      </section>
      <section>
        <h2>Channels</h2>
        <Downloads what="its messages" href={downloadHref(p, "/admin/channels", mind)} />
        <Count matched={p.messages.matched} total={p.messages.matched} shown={p.messages.entries.length} noun="messages" />
        <LogBox label="Its messages">
          <Messages top={p} messages={p.messages.entries} empty="No messages sent or received." />
        </LogBox>
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
        <Downloads what="its Record" href={downloadHref(p, "/admin/record", recordFilter)} />
        <Downloads what="its orders" href={downloadHref(p, "/admin/orders", mind)} />
        <Count matched={p.record.matched} total={p.record.matched} shown={p.record.entries.length} noun="entries" />
        <LogBox label="Its Record">
          <Entries top={p} entries={p.record.entries} empty="Nothing in the Record about it." />
        </LogBox>
        <Older href={props.olderHref} />
      </section>
    </AdminLayout>
  );
}

const epochField = (top: AdminEpoch) => (top.newest ? null : top.epoch.number);

export function AdminChannelsView(props: { ctx: PageCtx; page: AdminListPage<AdminMessage>; filter: Filters; olderHref: string | null }) {
  const p = props.page;
  const f = props.filter;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/channels" title="Every channel">
      <FilterForm action="/admin/channels" epoch={epochField(p)} clear={adminHref(p, "/admin/channels")}>
        <MindSelect top={p} name="mind" label="Mind" value={f["mind"]} />{" "}
        <MindSelect top={p} name="with" label="With" value={f["with"]} /> <DaySelect top={p} value={f["day"]} />
      </FilterForm>
      <Downloads what="these messages" href={downloadHref(p, "/admin/channels", f)} />
      <Count matched={p.matched} total={p.total} shown={p.entries.length} noun="messages" />
      <LogBox label="Messages">
        <Messages top={p} messages={p.entries} empty="No messages." />
      </LogBox>
      <Older href={props.olderHref} />
    </AdminLayout>
  );
}

export function AdminRecordView(props: { ctx: PageCtx; page: AdminListPage<AdminEntry>; filter: Filters; olderHref: string | null }) {
  const p = props.page;
  const f = props.filter;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/record" title="The whole Record">
      <FilterForm action="/admin/record" epoch={epochField(p)} clear={adminHref(p, "/admin/record")}>
        {f["n"] !== undefined && <input type="hidden" name="n" value={f["n"]} />}
        <MindSelect top={p} name="mind" label="Mind" value={f["mind"]} />{" "}
        <Pick name="type" label="Event" value={f["type"]} options={p.choices.types.map((t): [string, string] => [t, typeLabel(t)])} />{" "}
        <DaySelect top={p} value={f["day"]} />{" "}
        <Pick
          name="seen"
          label="Seen by"
          value={f["seen"]}
          options={[
            ["public", "public"],
            ["private", "private only"],
          ]}
        />
      </FilterForm>
      <Downloads what="these entries" href={downloadHref(p, "/admin/record", f)} />
      <Count matched={p.matched} total={p.total} shown={p.entries.length} noun="entries" />
      <LogBox label="Record entries">
        <Entries top={p} entries={p.entries} empty="Nothing in the Record matches." />
      </LogBox>
      <Older href={props.olderHref} />
    </AdminLayout>
  );
}

const json = (v: unknown) => JSON.stringify(v) ?? "null";

function LogItem(props: { top: AdminEpoch; e: AdminLogEntry }) {
  const e = props.e;
  return (
    <li id={`order-${e.index}`}>
      <p>
        <a href={`#order-${e.index}`} class="anchor">
          #{e.index}
        </a>{" "}
        · <Time at={e.at} /> · {e.account} {e.kind === "boot" ? "booted" : "ordered for"} <AdminMind top={props.top} mind={e.mind} />
        {e.kind === "orders" && e.orders.length < e.calls && <span class="muted"> ({e.orders.length} of the call's {e.calls} orders)</span>}
      </p>
      {e.kind === "boot" && <pre class="numbers wrapped">{json(e.input)}</pre>}
      {e.orders.length > 0 && (
        <ol class="results">
          {e.orders.map((o) => (
            <li class={o.result?.ok ? "ok" : "refused"} value={o.n}>
              <code>{json(o.order)}</code>
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

export function AdminOrdersView(props: { ctx: PageCtx; page: AdminListPage<AdminLogEntry>; filter: Filters; olderHref: string | null }) {
  const p = props.page;
  const f = props.filter;
  return (
    <AdminLayout ctx={props.ctx} top={p} here="/admin/orders" title="The orders log">
      <FilterForm action="/admin/orders" epoch={epochField(p)} clear={adminHref(p, "/admin/orders")}>
        <Pick name="account" label="Account" value={f["account"]} options={p.choices.accounts} />{" "}
        <MindSelect top={p} name="mind" label="Mind" value={f["mind"]} />{" "}
        <Pick name="order" label="Order" value={f["order"]} options={["boot", ...p.choices.orders]} />{" "}
        <Pick
          name="result"
          label="Result"
          value={f["result"]}
          options={[
            ["refused", "refused only"],
            ["ok", "carried out only"],
          ]}
        />{" "}
        <DaySelect top={p} value={f["day"]} />
      </FilterForm>
      <Downloads what="these orders" href={downloadHref(p, "/admin/orders", f)} />
      <Count matched={p.matched} total={p.total} shown={p.entries.length} noun="boots and calls" />
      <LogBox label="Orders log">
        {p.entries.length === 0 ? (
          <p class="muted">Nothing in the log matches.</p>
        ) : (
          <ol class="adminlog">
            {p.entries.map((e) => (
              <LogItem top={p} e={e} />
            ))}
          </ol>
        )}
      </LogBox>
      <Older href={props.olderHref} />
    </AdminLayout>
  );
}
