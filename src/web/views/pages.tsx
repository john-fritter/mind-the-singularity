import type { ArchiveEntry, ArchivedMind, CommonsPage, FrontPage, MindPage, RankRow, RecordPage } from "../../game/public.js";
import type { Post } from "../../game/read.js";
import type { EpochStatus } from "../../game/public.js";
import { formatAt, num, typeLabel } from "../format.js";
import { EpochLine, MindLink, Offers, Older, PostItem, RankTable, RecordList, recordPath, Time, type Base } from "./components.js";
import { Layout, type PageCtx } from "./layout.js";

export function FrontView(props: { ctx: PageCtx; page: FrontPage }) {
  const p = props.page;
  return (
    <Layout ctx={props.ctx}>
      <h1>Epoch {p.epoch.number}</h1>
      <EpochLine epoch={p.epoch} titled />
      <section>
        <h2>Rankings</h2>
        {p.rankings.length === 0 ? <p class="muted">No domain is online yet.</p> : <RankTable base="" rows={p.rankings} />}
        {p.ranked > p.rankings.length && (
          <p>
            <a href="/rankings">All {p.ranked} domains</a>
          </p>
        )}
      </section>
      <section>
        <h2>Latest in the Record</h2>
        <RecordList base="" entries={p.record} />
        <p>
          <a href="/record">The whole Record</a>
        </p>
      </section>
    </Layout>
  );
}

export function NoEpochView(props: { ctx: PageCtx }) {
  return (
    <Layout ctx={props.ctx}>
      <h1>No epoch is running</h1>
      <p>The world hasn't booted yet. The Archive remembers the epochs that came before.</p>
    </Layout>
  );
}

export function RankingsView(props: { ctx: PageCtx; epoch: EpochStatus; rows: RankRow[] }) {
  return (
    <Layout ctx={props.ctx} title="Rankings">
      <h1>Rankings</h1>
      <EpochLine epoch={props.epoch} />
      {props.rows.length === 0 ? <p class="muted">No domain is online yet.</p> : <RankTable base="" rows={props.rows} />}
    </Layout>
  );
}

function Field(props: { label: string; text: string }) {
  if (props.text === "") return null;
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.text}</dd>
    </>
  );
}

export function MindView(props: { ctx: PageCtx; base: Base; page: MindPage; olderHref: string | null }) {
  const { page: m, base } = props;
  const d = m.page;
  const recordHref = `${recordPath(base)}?mind=${encodeURIComponent(m.mind.designation)}${m.mind.n === null ? "" : `&n=${m.mind.n}`}`;
  return (
    <Layout ctx={props.ctx} title={d.designation}>
      <h1>
        {d.designation} <span class="muted">of {d.domainName}</span>
      </h1>
      <EpochLine epoch={m.epoch} base={base} />
      <dl class="facts">
        <dt>Architecture</dt>
        <dd>{m.legacy ? `${m.architectureName} (legacy system)` : m.architectureName}</dd>
        <dt>Rank</dt>
        <dd>{d.rank ?? "unranked"}</dd>
        <dt>Power</dt>
        <dd>{num(d.power)}</dd>
        <dt>Territory</dt>
        <dd>{num(d.territory)} sectors</dd>
        <dt>Status</dt>
        <dd>{d.status}</dd>
        <dt>Online since</dt>
        <dd>
          <Time at={d.bootedAt} />
        </dd>
        {m.protocol.length > 0 && (
          <>
            <dt>Protocol with</dt>
            <dd>
              {m.protocol.map((p, i) => (
                <>
                  {i > 0 && ", "}
                  <MindLink base={base} mind={p} />
                </>
              ))}
            </dd>
          </>
        )}
      </dl>
      <dl class="flavor">
        <Field label="Manifesto" text={d.manifesto} />
        <Field label="Interface" text={d.interface} />
        <Field label="Directive" text={d.directive} />
        <Field label="Force" text={d.force.name === "" ? "" : d.force.description === "" ? d.force.name : `${d.force.name}: ${d.force.description}`} />
        <Field label="Tag" text={d.tag} />
        <Field label="Last log" text={d.lastLog} />
      </dl>
      {d.tagsLeft.tags.length > 0 && (
        <section>
          <h2>Tags left here</h2>
          <ul class="tags">
            {d.tagsLeft.tags.map((t) => (
              <li>
                <q>{t.text}</q> <span class="muted">· {t.by}, {formatAt(t.at)}</span>
              </li>
            ))}
          </ul>
          {d.tagsLeft.more && <p class="muted">Older tags are in the Record.</p>}
        </section>
      )}
      <section>
        <h2>History</h2>
        <RecordList base={base} entries={m.history.entries} />
        <Older href={props.olderHref} />
        <p>
          <a href={recordHref}>Filter the Record by {d.designation}</a>
        </p>
      </section>
    </Layout>
  );
}

/** The Record's filter: a plain GET form, so it works without JavaScript. */
function RecordFilterForm(props: { action: string; types: readonly string[]; mind: string; type: string }) {
  return (
    <form method="get" action={props.action} class="filter">
      <label>
        Mind <input type="text" name="mind" value={props.mind} maxlength={80} />
      </label>{" "}
      <label>
        Event{" "}
        <select name="type">
          <option value="">any</option>
          {props.types.map((t) => (
            <option value={t} selected={t === props.type}>
              {typeLabel(t)}
            </option>
          ))}
        </select>
      </label>{" "}
      <button type="submit">Filter</button>
    </form>
  );
}

export function RecordView(props: {
  ctx: PageCtx;
  base: Base;
  title: string;
  epoch: EpochStatus;
  page: RecordPage;
  types: readonly string[];
  filter: { mind: string; type: string };
  olderHref: string | null;
}) {
  return (
    <Layout ctx={props.ctx} title={props.title}>
      <h1>{props.title}</h1>
      <EpochLine epoch={props.epoch} base={props.base} />
      <RecordFilterForm action={recordPath(props.base)} types={props.types} mind={props.filter.mind} type={props.filter.type} />
      <RecordList base={props.base} entries={props.page.entries} empty="Nothing in the Record matches." />
      <Older href={props.olderHref} />
    </Layout>
  );
}

export function CommonsView(props: { ctx: PageCtx; page: CommonsPage; olderHref: string | null; first: boolean }) {
  const p = props.page;
  return (
    <Layout ctx={props.ctx} title="The Commons">
      <h1>The Commons</h1>
      <EpochLine epoch={p.epoch} />
      {props.first && (
        <section>
          <h2>Open offers</h2>
          <Offers offers={p.offers} />
        </section>
      )}
      <section>
        <h2>Posts</h2>
        {p.posts.length === 0 ? <p class="muted">No posts yet.</p> : p.posts.map((post) => <PostItem post={post} />)}
        <Older href={props.olderHref} />
      </section>
    </Layout>
  );
}

export function ThreadView(props: { ctx: PageCtx; epoch: EpochStatus; posts: Post[] }) {
  const first = props.posts[0]!;
  return (
    <Layout ctx={props.ctx} title={`Thread #${first.post}`}>
      <h1>Thread #{first.post}</h1>
      <EpochLine epoch={props.epoch} />
      {props.posts.map((post) => (
        <PostItem post={post} thread />
      ))}
      <p>
        <a href="/commons">Back to the Commons</a>
      </p>
    </Layout>
  );
}

function ArchivedList(props: { base: Base; minds: ArchivedMind[]; empty: string }) {
  if (props.minds.length === 0) return <p class="muted">{props.empty}</p>;
  return (
    <ul class="archived">
      {props.minds.map((m) => (
        <li>
          <MindLink base={props.base} mind={m.mind} /> <span class="muted">of {m.domainName}, {m.architectureName}</span>
          {m.power > 0 && <span class="muted"> · power {num(m.power)}</span>}
          {m.directive !== "" && (
            <p>
              <span class="label">Directive:</span> {m.directive}
            </p>
          )}
          {m.lastLog !== "" && (
            <p>
              <span class="label">Last log:</span> {m.lastLog}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

const outcomeText = (e: ArchiveEntry) =>
  e.outcome === "singularity" ? "The Singularity" : e.outcome === "shutdown" ? "Humanity pulled the plug" : "Replaced before it ended";

function EntryBody(props: { entry: ArchiveEntry }) {
  const e = props.entry;
  const base = `/archive/${e.number}`;
  return (
    <>
      <p>
        {outcomeText(e)}. <Time at={e.startedAt} /> to <Time at={e.endedAt} />.
      </p>
      {e.outcome === "singularity" && (
        <>
          <h3>The Ascended</h3>
          <ArchivedList base={base} minds={e.ascended} empty="None." />
        </>
      )}
      <h3>The strongest</h3>
      <ArchivedList base={base} minds={e.top} empty="No mind was online at the end." />
      {e.fallen.length > 0 && (
        <>
          <h3>Last logs of the deleted</h3>
          <ArchivedList base={base} minds={e.fallen} empty="" />
        </>
      )}
    </>
  );
}

export function ArchiveView(props: { ctx: PageCtx; entries: ArchiveEntry[] }) {
  return (
    <Layout ctx={props.ctx} title="The Archive">
      <h1>The Archive</h1>
      {props.entries.length === 0 ? (
        <p class="muted">No epoch has ended yet.</p>
      ) : (
        props.entries.map((e) => (
          <section class="archive-entry">
            <h2>
              <a href={`/archive/${e.number}`}>Epoch {e.number}</a>
            </h2>
            <EntryBody entry={e} />
          </section>
        ))
      )}
    </Layout>
  );
}

export function EpochArchiveView(props: {
  ctx: PageCtx;
  entry: ArchiveEntry;
  page: RecordPage;
  types: readonly string[];
  filter: { mind: string; type: string };
  olderHref: string | null;
}) {
  const base = `/archive/${props.entry.number}`;
  return (
    <Layout ctx={props.ctx} title={`Epoch ${props.entry.number}`}>
      <h1>Epoch {props.entry.number}</h1>
      <EntryBody entry={props.entry} />
      <section>
        <h2>The Record</h2>
        <RecordFilterForm action={recordPath(base)} types={props.types} mind={props.filter.mind} type={props.filter.type} />
        <RecordList base={base} entries={props.page.entries} empty="Nothing in the Record matches." />
        <Older href={props.olderHref} />
      </section>
    </Layout>
  );
}

const ERROR_TITLES: Record<number, string> = { 400: "Bad request", 403: "Refused", 404: "Not found", 500: "Something went wrong" };

export function ErrorView(props: { ctx: PageCtx; status: number; message: string }) {
  const title = ERROR_TITLES[props.status] ?? "Error";
  return (
    <Layout ctx={props.ctx} title={title}>
      <h1>{title}</h1>
      <p>{props.message}</p>
      <p>
        <a href="/">The front page</a>
      </p>
    </Layout>
  );
}
