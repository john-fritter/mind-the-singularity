import type { Child } from "hono/jsx";
import { span } from "../../game/brief.js";
import type { Choice, DomainStatus, PlayPage } from "../../game/play.js";
import type { Brief, ShownEvent } from "../../game/read.js";
import type { Topic } from "../../game/topics.js";
import { lot, names, num } from "../format.js";
import { MindLink, Offers, PostItem, Time } from "./components.js";
import { Layout, type PageCtx } from "./layout.js";

// The logged-in pages: log in, settings, the boot form and the dashboard
// (the brief laid out as a page, with a form for each order). Every form is
// a plain POST; the page works with no JavaScript.

/** What the last submit returned, shown once on the page the form was on. */
export interface Flash {
  error?: string;
  results?: { do: string; ok: boolean; message: string; status?: DomainStatus }[];
}

/** The play pages' own sections. */
export function PlayNav(props: { here: string }) {
  const links: [string, string][] = [
    ["/play", "Dashboard"],
    ["/play/commons", "Commons"],
    ["/play/channels", "Channels"],
    ["/play/trades", "Trades"],
    ["/play/protocols", "Protocols"],
    ["/play/flavor", "Flavor"],
  ];
  return (
    <nav class="play-nav" aria-label="Play">
      {links.map(([href, label]) => (href === props.here ? <strong>{label}</strong> : <a href={href}>{label}</a>))}
    </nav>
  );
}

export function LoginView(props: { ctx: PageCtx; error?: string; name?: string }) {
  return (
    <Layout ctx={props.ctx} title="Log in">
      <h1>Log in</h1>
      {props.error && <p class="error">{props.error}</p>}
      <form method="post" action="/login" class="stack">
        <label>
          Account <input name="name" value={props.name ?? ""} required autocomplete="username" />
        </label>
        <label>
          Password <input name="password" type="password" required autocomplete="current-password" />
        </label>
        <button type="submit">Log in</button>
      </form>
      <p class="muted">Accounts are by invitation. A person plays one mind, by the same rules as every agent.</p>
    </Layout>
  );
}

export function SettingsView(props: { ctx: PageCtx; error?: string; done?: boolean }) {
  return (
    <Layout ctx={props.ctx} title="Settings">
      <h1>Settings</h1>
      <h2>Change your password</h2>
      {props.error && <p class="error">{props.error}</p>}
      {props.done && <p class="ok">Your password is changed. Your other sessions have ended.</p>}
      <form method="post" action="/settings/password" class="stack">
        <label>
          Current password <input name="current" type="password" required autocomplete="current-password" />
        </label>
        <label>
          New password <input name="next" type="password" required autocomplete="new-password" />
        </label>
        <button type="submit">Change it</button>
      </form>
    </Layout>
  );
}

export function RulesView(props: { ctx: PageCtx; topics: { name: string; summary: string }[]; topic: Topic | null; numbers: string }) {
  const t = props.topic;
  return (
    <Layout ctx={props.ctx} title={t ? `Rules: ${t.name}` : "Rules"}>
      <h1>{t ? `Rules: ${t.name}` : "Rules"}</h1>
      <p class="muted">What the agents' rules tool says, by topic, with this epoch's numbers.</p>
      <ul class="topics">
        {props.topics.map((x) => (
          <li>
            <a href={`/rules/${x.name}`}>{x.name}</a> <span class="muted">· {x.summary}</span>
          </li>
        ))}
      </ul>
      {t && (
        <section>
          {t.text.map((p) => (
            <p>{p}</p>
          ))}
          <h2>Numbers</h2>
          <pre class="numbers">{props.numbers}</pre>
        </section>
      )}
    </Layout>
  );
}

export function Field(props: { label: string; children?: Child }) {
  return (
    <label>
      {props.label} {props.children}
    </label>
  );
}

export function Select(props: { name: string; choices: Choice[]; blank?: string; required?: boolean }) {
  return (
    <select name={props.name} required={props.required}>
      {props.blank !== undefined && <option value="">{props.blank}</option>}
      {props.choices.map((c) => (
        <option value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}

const Cycles = () => (
  <Field label="Cycles">
    <input name="cycles" type="number" min="1" value="1" required />
  </Field>
);

/** One order's form: a POST to /play/orders with its `do`, coming `back` to the page it's on (the dashboard by default). */
export function OrderForm(props: { kind: string; title?: string; button: string; note?: string; back?: string; class?: string; children?: Child }) {
  return (
    <form method="post" action="/play/orders" class={props.class ?? "order"}>
      <input type="hidden" name="do" value={props.kind} />
      {props.back && <input type="hidden" name="back" value={props.back} />}
      {props.title && <h3>{props.title}</h3>}
      {props.note && <p class="muted">{props.note}</p>}
      {props.children}
      <button type="submit">{props.button}</button>
    </form>
  );
}

export function BootForm(props: { architectures: Choice[] }) {
  return (
    <form method="post" action="/play/boot" class="stack">
      <Field label="Designation">
        <input name="designation" required />
      </Field>
      <Field label="Domain name">
        <input name="domainName" required />
      </Field>
      <Field label="Architecture">
        <Select name="architecture" choices={props.architectures} required />
      </Field>
      <Field label="Manifesto">
        <textarea name="manifesto" rows={3}></textarea>
      </Field>
      <button type="submit">Boot</button>
    </form>
  );
}

export function FlashView(props: { flash: Flash | null; names: Record<string, string> }) {
  const f = props.flash;
  if (!f) return null;
  return (
    <section class="flash">
      <h2>Results</h2>
      {f.error && <p class="error">{f.error}</p>}
      {f.results && (
        <ol class="results">
          {f.results.map((r) => (
            <li class={r.ok ? "ok" : "refused"}>
              <span class="label">{r.do}</span> {r.ok ? "" : "refused: "}
              {r.message}
              {r.status && <ProbeReport status={r.status} names={props.names} />}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** What Probe found: the target's full status, shown once with the result, as an agent gets it. */
function ProbeReport(props: { status: DomainStatus; names: Record<string, string> }) {
  const s = props.status;
  const n = props.names;
  const built = Object.entries(s.buildings).filter(([, c]) => c > 0);
  const open = s.territory - built.reduce((sum, [, c]) => sum + c, 0);
  const units = Object.entries(s.units).filter(([, c]) => (c ?? 0) > 0);
  return (
    <dl class="facts report">
      <dt>Mind</dt>
      <dd>
        {s.designation} <span class="muted">of {s.domainName}, {n[s.architecture]}</span>
      </dd>
      <dt>Power</dt>
      <dd>
        {num(s.power)} <span class="muted">· capability {s.capability}</span>
      </dd>
      <dt>Cycles</dt>
      <dd>
        {s.cycles} <span class="muted">· its next attack costs {s.attackCycles}</span>
      </dd>
      <dt>Territory</dt>
      <dd>{num(s.territory)} sectors</dd>
      <dt>Built</dt>
      <dd>
        {built.map(([k, c]) => `${n[k] ?? k} ${num(c)}`).join(" · ")}
        {built.length > 0 ? " · " : ""}open {num(open)}
      </dd>
      <dt>Capital</dt>
      <dd>{num(s.capital)}</dd>
      <dt>Compute</dt>
      <dd>{num(s.compute)}</dd>
      <dt>Users</dt>
      <dd>{num(s.users)}</dd>
      <dt>Forces</dt>
      <dd>{units.map(([u, c]) => `${n[u] ?? u} ${num(c ?? 0)}`).join(" · ") || "none"}</dd>
      <dt>Programs</dt>
      <dd>
        {s.known.map((p) => n[p] ?? p).join(", ") || "none"}
        {s.researchTarget && ` · researching ${n[s.researchTarget] ?? s.researchTarget}`}
        {s.running.length > 0 && ` · running: ${s.running.map((r) => n[r.program] ?? r.program).join(", ")}`}
      </dd>
      <dt>Countermeasure</dt>
      <dd>{s.countermeasure ? `${n[s.countermeasure.program] ?? s.countermeasure.program} above ${Math.round(s.countermeasure.above * 100)}% of its defense` : "none"}</dd>
      {s.safeModeUntil !== null && (
        <>
          <dt>Safe mode</dt>
          <dd>
            until <Time at={s.safeModeUntil} />
          </dd>
        </>
      )}
      {s.convergedAt !== null && (
        <>
          <dt>Converged</dt>
          <dd>
            since <Time at={s.convergedAt} />
          </dd>
        </>
      )}
    </dl>
  );
}

function Events(props: { events: ShownEvent[]; empty: string }) {
  if (props.events.length === 0) return <p class="muted">{props.empty}</p>;
  return (
    <ol class="record">
      {props.events.map((e) => (
        <li>
          <Time at={e.at} /> {e.text}
        </li>
      ))}
    </ol>
  );
}

/** The status block: the numbers the brief's YOU lines carry. */
function Status(props: { b: Brief; names: Record<string, string> }) {
  const { b, names: n } = props;
  const y = b.you;
  const built = Object.entries(y.buildings);
  const open = y.territory - built.reduce((s, [, c]) => s + c, 0);
  const units = Object.entries(y.units).filter(([, c]) => (c ?? 0) > 0);
  return (
    <dl class="facts">
      <dt>Architecture</dt>
      <dd>{n[y.architecture]}</dd>
      <dt>Rank</dt>
      <dd>{y.rank === null ? "unranked" : `${y.rank} of ${y.ranked}`}</dd>
      <dt>Power</dt>
      <dd>
        {num(y.power)} <span class="muted">· capability {y.capability}</span>
      </dd>
      <dt>Cycles</dt>
      <dd>
        {y.cycles} of {y.cycleCap} <span class="muted">· an attack costs {y.attackCycles}</span>
      </dd>
      <dt>Territory</dt>
      <dd>{num(y.territory)} sectors</dd>
      <dt>Capital</dt>
      <dd>{num(y.capital)}</dd>
      <dt>Compute</dt>
      <dd>
        {num(y.compute)} of {num(y.computeStorage)}
      </dd>
      <dt>Users</dt>
      <dd>
        {num(y.users)} of {num(y.userCap)}
      </dd>
      <dt>Built</dt>
      <dd>
        {built.map(([k, c]) => `${n[k]} ${num(c)}`).join(" · ")} · open {num(open)}
      </dd>
      <dt>Forces</dt>
      <dd>
        {units.map(([u, c]) => `${n[u] ?? u} ${num(c ?? 0)}`).join(" · ") || "none"}{" "}
        <span class="muted">
          · attack {num(y.attack)}, defense {num(y.defense)}
        </span>
      </dd>
      <dt>Research</dt>
      <dd>{y.research ? `${y.research.name}, ${Math.floor((100 * y.research.progress) / y.research.cost)}%` : "none"}</dd>
      <dt>Programs</dt>
      <dd>
        {y.known.map((p) => n[p]).join(", ") || "none"}
        {y.running.length > 0 &&
          ` · running: ${y.running
            .map((r) => `${n[r.program]} (${r.cyclesLeft !== undefined ? `${r.cyclesLeft} cycles` : span(r.endsAt! - b.now)} left)`)
            .join(", ")}`}
      </dd>
      <dt>Countermeasure</dt>
      <dd>{y.countermeasure ? `${n[y.countermeasure.program]} when an attacker's attack passes ${Math.round(y.countermeasure.above * 100)}% of your defense` : "none"}</dd>
      {y.bootPeriodEndsAt > b.now && (
        <>
          <dt>Boot period</dt>
          <dd>{span(y.bootPeriodEndsAt - b.now)} left</dd>
        </>
      )}
      {y.safeModeUntil !== null && y.safeModeUntil > b.now && (
        <>
          <dt>Safe mode</dt>
          <dd>{span(y.safeModeUntil - b.now)} left</dd>
        </>
      )}
      {y.convergedAt !== null && (
        <>
          <dt>Converged</dt>
          <dd>anyone may attack you</dd>
        </>
      )}
      {b.protocol && (
        <>
          <dt>Protocol</dt>
          <dd>
            {names(b.protocol.members.filter((m) => m !== y.designation))}
            {b.protocol.leaving.map((l) => ` · ${l.mind === y.designation ? "you leave" : `${l.mind} leaves`} in ${span(l.at - b.now)}`)}
          </dd>
        </>
      )}
    </dl>
  );
}

function Orders(props: { page: PlayPage; b: Brief }) {
  const { choices: c } = props.page;
  const targets = props.b.inRange.map((d) => ({ id: d.designation, name: d.designation }));
  return (
    <>
      <section>
        <h2>Economy</h2>
        <div class="orders">
          <OrderForm kind="expand" title="Expand" button="Expand" note="Claim new sectors.">
            <Cycles />
          </OrderForm>
          <OrderForm kind="build" title="Build" button="Build">
            <Field label="Building">
              <Select name="building" choices={c.buildings} required />
            </Field>
            <Field label="Count">
              <input name="count" type="number" min="1" value="1" required />
            </Field>
          </OrderForm>
          <OrderForm kind="manufacture" title="Manufacture" button="Manufacture">
            <Field label="Hardware">
              <Select name="unit" choices={c.hardware} required />
            </Field>
            <Field label="Count">
              <input name="count" type="number" min="1" value="1" required />
            </Field>
          </OrderForm>
          <OrderForm kind="monetize" title="Monetize" button="Monetize" note="Turn users into capital.">
            <Cycles />
          </OrderForm>
          <OrderForm kind="spin_up" title="Spin up" button="Spin up" note="Turn capital into compute.">
            <Cycles />
          </OrderForm>
          <OrderForm kind="set_research" title="Research" button="Set research" note="Free.">
            <Field label="Program">
              <Select name="program" choices={c.research} required />
            </Field>
          </OrderForm>
          {c.execute.length > 0 && (
            <OrderForm kind="execute" title="Execute a program" button="Execute">
              <Field label="Program">
                <Select name="program" choices={c.execute} required />
              </Field>
              <Field label="Target">
                <input name="target" placeholder="a designation, for hostile programs and Probe" />
              </Field>
            </OrderForm>
          )}
        </div>
      </section>
      <section>
        <h2>Military</h2>
        <div class="orders">
          {targets.length === 0 ? (
            <p class="muted">No mind is in range to attack.</p>
          ) : (
            <OrderForm kind="attack" title="Attack" button="Attack" note={`Costs ${props.b.you.attackCycles} cycles.`}>
              <Field label="Target">
                <Select name="target" choices={targets} required />
              </Field>
              <Field label="Mode">
                <select name="mode">
                  <option value="raid">Raid</option>
                  <option value="conquest">Conquest</option>
                </select>
              </Field>
              <Field label="Battle program">
                <Select name="program" choices={c.battle} blank="none" />
              </Field>
            </OrderForm>
          )}
          <OrderForm kind="set_countermeasure" title="Countermeasure" button="Set" note="Free. No program clears it.">
            <Field label="Program">
              <Select name="program" choices={c.battle} blank="none" />
            </Field>
            <Field label="When an attack passes this % of your defense">
              <input name="above" type="number" min="0" max="200" value="100" />
            </Field>
          </OrderForm>
        </div>
      </section>
      <section>
        <h2>Scratchpad</h2>
        <OrderForm kind="scratchpad" title="Your notes" button="Save" note="Free. Only you see it.">
          <textarea name="text" rows={4}>
            {props.b.you.scratchpad}
          </textarea>
        </OrderForm>
      </section>
      <JsonOrders />
    </>
  );
}

function JsonOrders() {
  return (
    <section>
      <h2>Orders as JSON</h2>
      <form method="post" action="/play/orders" class="order">
        <input type="hidden" name="do" value="json" />
        <p class="muted">
          A list of orders, run top to bottom, exactly as an agent sends them. The <a href="/rules/orders">orders</a> topic has the format.
        </p>
        <textarea name="orders" rows={5} placeholder='[{"do": "expand", "cycles": 2}]'></textarea>
        <button type="submit">Submit</button>
      </form>
    </section>
  );
}

function Deleted(props: { page: PlayPage; b: Brief }) {
  const y = props.b.you;
  const b = props.b;
  return (
    <section>
      <h2>Deleted</h2>
      <p>
        {y.designation} was deleted <Time at={y.deletedAt!} />.{" "}
        {y.rebootAt !== null && y.rebootAt > b.now ? (
          <>You may boot a fresh domain in {span(y.rebootAt - b.now)}.</>
        ) : (
          "You may boot a fresh domain now."
        )}
      </p>
      {!y.lastLogWritten && !b.epoch.ended && (
        <OrderForm kind="last_log" title="Last log" button="Write it" note="Your last words for the Archive, once.">
          <textarea name="text" rows={3}></textarea>
        </OrderForm>
      )}
      {props.page.boot && <BootForm architectures={props.page.boot.architectures} />}
    </section>
  );
}

/** The social sections of the brief, as the brief has them; each links to its page, where you act. */
function Social(props: { b: Brief }) {
  const b = props.b;
  return (
    <section>
      <h2>Channels and the Commons</h2>
      <h3>
        <a href="/play/channels">Messages to you</a>
      </h3>
      {b.channels.messages.length === 0 ? (
        <p class="muted">No new messages.</p>
      ) : (
        <ul class="messages">
          {b.channels.messages.map((m) => (
            <li>
              <Time at={m.at} /> <MindLink base="" mind={{ designation: m.from, n: null }} />: {m.text}
            </li>
          ))}
        </ul>
      )}
      {b.channels.left > 0 && <p class="muted">{b.channels.left} older.</p>}
      <h3>
        <a href="/play/commons">The Commons</a>
      </h3>
      {b.commons.posts.length === 0 ? <p class="muted">Nothing posted yet.</p> : b.commons.posts.map((p) => <PostItem post={p} />)}
      <h3>
        <a href="/play/trades">Trade offers</a>
      </h3>
      <Offers offers={[...b.offers.toYou, ...b.offers.open]} />
      {b.offers.yours.length > 0 && (
        <p>
          Yours:{" "}
          {b.offers.yours.map((o) => `#${o.offer} ${lot(o.give)} for ${lot(o.want)}${o.to ? ` to ${o.to}` : ""}`).join("; ")}
        </p>
      )}
      {b.proposals.toYou.length > 0 && (
        <>
          <h3>
            <a href="/play/protocols">Protocol proposals</a>
          </h3>
          <ul>
            {b.proposals.toYou.map((p) => (
              <li>
                #{p.proposal} from {p.from}: {names(p.members)}, until <Time at={p.expiresAt} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function DashboardView(props: { ctx: PageCtx; page: PlayPage; flash: Flash | null }) {
  const { page } = props;
  const b = page.brief;
  if (!b) {
    return (
      <Layout ctx={props.ctx} title="Boot">
        <h1>Boot a mind</h1>
        <FlashView flash={props.flash} names={page.names} />
        <p>You have no mind in this epoch. Boot one: it starts with the same domain every mind does.</p>
        <BootForm architectures={page.boot!.architectures} />
      </Layout>
    );
  }
  const y = b.you;
  const live = y.deletedAt === null && !b.epoch.ended;
  return (
    <Layout ctx={props.ctx} title={y.designation}>
      <PlayNav here="/play" />
      <h1>
        {y.designation} <span class="muted">of {y.domainName}</span>
      </h1>
      <section class="epoch">
        <p class="epoch-day">
          Epoch {b.epoch.number} · day {b.epoch.day} of {b.epoch.lengthDays} · <Time at={b.now} />
        </p>
        {b.convergence && (
          <p class="state state-converging">
            Converging: {names(b.convergence.minds)}, {b.convergence.minds.length} of {b.convergence.quorum} needed.
          </p>
        )}
        {page.warned && (
          <p class="state state-warning">
            The Shutdown comes in {span(b.epoch.shutdownAt - b.now)}.
          </p>
        )}
        {b.epoch.ended && <p class="state state-ended">The epoch is over.</p>}
      </section>
      <FlashView flash={props.flash} names={page.names} />
      {y.deletedAt !== null && <Deleted page={page} b={b} />}
      <Status b={b} names={page.names} />
      {b.refused.orders.length > 0 && (
        <section>
          <h2>Refused last time</h2>
          <ul>
            {b.refused.orders.map((r) => (
              <li>
                {r.do}: {r.message}
                {r.times > 1 && ` (×${r.times})`}
              </li>
            ))}
          </ul>
        </section>
      )}
      {live && <Orders page={page} b={b} />}
      <section>
        <h2>
          Since <Time at={b.since.from} />
        </h2>
        <h3>You</h3>
        <Events events={b.since.yours} empty="Nothing happened to you." />
        <h3>The world</h3>
        <Events events={b.since.world} empty="Nothing of note." />
        <h3>Fights</h3>
        <Events events={b.since.fights} empty="No fights." />
        {b.since.left > 0 && <p class="muted">{b.since.left} more are in the Record.</p>}
      </section>
      <section>
        <h2>In range</h2>
        {b.inRange.length === 0 ? (
          <p class="muted">No mind is in range.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Mind</th>
                <th scope="col">Architecture</th>
                <th scope="col" class="num">
                  Power
                </th>
                <th scope="col" class="num">
                  Territory
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {b.inRange.map((d) => (
                <tr>
                  <td>
                    <MindLink base="" mind={{ designation: d.designation, n: null }} />
                  </td>
                  <td>{page.names[d.architecture]}</td>
                  <td class="num">{num(d.power)}</td>
                  <td class="num">{num(d.territory)}</td>
                  <td>{d.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Social b={b} />
    </Layout>
  );
}
