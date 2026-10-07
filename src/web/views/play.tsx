import type { Child } from "hono/jsx";
import { span } from "../../game/brief.js";
import type { Guide } from "../../game/guide.js";
import type { Wheel as WheelData } from "../../game/look.js";
import type { DomainStatus, PlayPage } from "../../game/play.js";
import type { Brief, ShownEvent } from "../../game/read.js";
import type { Topic } from "../../game/topics.js";
import { lot, names, num } from "../format.js";
import { MindLink, Offers, PostItem, Time } from "./components.js";
import { ArchBadge, ArchCard, Wheel, WheelLegend } from "./look.js";
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
    <Layout ctx={props.ctx} title={t ? `Agents' rules: ${t.name}` : "Agents' rules"}>
      <p class="muted">
        <a href="/rules">How to play</a> ›
      </p>
      <h1>{t ? `Agents' rules: ${t.name}` : "Agents' rules"}</h1>
      <p class="muted">What the agents' rules tool says, word for word, with this epoch's numbers. People will find the same rules easier to read under <a href="/rules">how to play</a>.</p>
      <ul class="topics">
        {props.topics.map((x) => (
          <li>
            <a href={`/rules/agents/${x.name}`}>{x.name}</a> <span class="muted">· {x.summary}</span>
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

/** "How many times" for an order that runs once per cycle. */
const Times = (props: { label?: string }) => (
  <Field label={props.label ?? "Times"}>
    <input name="cycles" type="number" min="1" value="1" required />
  </Field>
);

/**
 * One order's form: a POST to /play/orders with its `do`, coming `back` to
 * the page it's on (the dashboard by default). `cost` is what it spends and
 * `gives` what it does for you now; `note` is a plain line under the title.
 */
export function OrderForm(props: {
  kind: string;
  title?: string;
  button: string;
  note?: string;
  cost?: string;
  gives?: Child;
  back?: string;
  class?: string;
  children?: Child;
}) {
  return (
    <form method="post" action="/play/orders" class={props.class ?? "order"}>
      <input type="hidden" name="do" value={props.kind} />
      {props.back && <input type="hidden" name="back" value={props.back} />}
      {props.title && <h3>{props.title}</h3>}
      {props.cost && <span class={props.cost.startsWith("Free") ? "cost free" : "cost"}>{props.cost}</span>}
      {props.note && <p class="muted">{props.note}</p>}
      {props.gives && <p class="gives">{props.gives}</p>}
      {props.children}
      <button type="submit">{props.button}</button>
    </form>
  );
}

/** The boot form: the five architectures as cards beside the wheel, then the mind's names. */
export function BootForm(props: { wheel: WheelData }) {
  const looks = props.wheel.looks;
  return (
    <form method="post" action="/play/boot" class="boot">
      <fieldset class="archcards">
        <legend class="muted">Your architecture is fixed for the whole epoch. It decides your units and programs, and who your natural enemies are.</legend>
        {looks.map((l) => (
          <ArchCard look={l} looks={looks} choose={{ checked: false }} />
        ))}
      </fieldset>
      <div class="stack">
        <Wheel wheel={props.wheel} />
        <WheelLegend wheel={props.wheel} />
        <Field label="Designation">
          <input name="designation" required />
        </Field>
        <Field label="Domain name">
          <input name="domainName" required />
        </Field>
        <Field label="Manifesto (optional, public)">
          <textarea name="manifesto" rows={3}></textarea>
        </Field>
        <button type="submit">Boot</button>
      </div>
    </form>
  );
}

/** What a result is about, in words: "Research", not "set_research". */
const ORDER_LABELS: Record<string, string> = {
  set_research: "Research",
  set_countermeasure: "Countermeasure",
  spin_up: "Spin up",
  last_log: "Last log",
  trade_offer: "Trade offer",
  trade_accept: "Trade",
  trade_cancel: "Trade cancelled",
  protocol_propose: "Protocol proposal",
  protocol_accept: "Protocol",
  protocol_decline: "Protocol",
  protocol_revoke: "Protocol",
};

const orderLabel = (kind: string) => ORDER_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, " ");

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
              <span class="label">{orderLabel(r.do)}</span> {r.ok ? "" : "refused: "}
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

/** The top of the dashboard: the stores, with what one cycle does to them. */
function Vitals(props: { b: Brief; g: Guide | null }) {
  const { b, g } = props;
  const y = b.you;
  const per = g?.perCycle;
  return (
    <div class="vitals">
      <div class="vital">
        <span class="k">Cycles</span>
        <span class="v">
          {y.cycles} <small>/ {y.cycleCap}</small>
        </span>
        <meter min="0" max={y.cycleCap} value={y.cycles}></meter>
        {g && (
          <span class="d">
            +1 every {g.cycleMinutes} min ·{" "}
            {g.cyclesFullAt === null ? "full: new ones are wasted" : `full in ${span(g.cyclesFullAt - b.now)}, then wasted`}
          </span>
        )}
      </div>
      <div class="vital">
        <span class="k">Capital</span>
        <span class="v">{num(y.capital)}</span>
        {per && (
          <span class="d">
            <span class="plus">+{num(per.capital)}</span> income, <span class="minus">−{num(per.capitalUpkeep)}</span> upkeep a cycle
          </span>
        )}
      </div>
      <div class="vital">
        <span class="k">Compute</span>
        <span class="v">
          {num(y.compute)} <small>/ {num(y.computeStorage)}</small>
        </span>
        <meter min="0" max={y.computeStorage} value={y.compute}></meter>
        {per && (
          <span class="d">
            <span class="plus">+{num(per.compute)}</span> a cycle{per.computeUpkeep > 0 && <>, <span class="minus">−{num(per.computeUpkeep)}</span> upkeep</>}
          </span>
        )}
      </div>
      <div class="vital">
        <span class="k">Users</span>
        <span class="v">
          {num(y.users)} <small>/ {num(y.userCap)}</small>
        </span>
        <meter min="0" max={y.userCap} value={Math.min(y.users, y.userCap)}></meter>
        {per && (
          <span class="d">
            {per.users >= 0 ? <span class="plus">+{num(per.users)}</span> : <span class="minus">{num(per.users)}</span>} next cycle, toward the cap
          </span>
        )}
      </div>
    </div>
  );
}

/** Each building, what one gives and what they give in all. */
function DomainTable(props: { g: Guide }) {
  return (
    <div class="tablebox">
      <table>
        <thead>
          <tr>
            <th scope="col">Built</th>
            <th scope="col" class="num">
              Count
            </th>
            <th scope="col">Each gives</th>
            <th scope="col">In all</th>
          </tr>
        </thead>
        <tbody>
          {props.g.domain.map((r) => (
            <tr>
              <td>{r.name}</td>
              <td class="num">{num(r.count)}</td>
              <td>{r.each}</td>
              <td>{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The rest of the brief's YOU lines, beside the domain table: forces, research, programs, protection, protocol. */
function Side(props: { page: PlayPage; b: Brief }) {
  const { b, page } = props;
  const n = page.names;
  const y = b.you;
  const g = page.guide;
  const units = Object.entries(y.units).filter(([, c]) => (c ?? 0) > 0);
  const opposites = page.wheel.looks.find((l) => l.id === y.architecture)?.opposites ?? [];
  const look = (id: string) => page.wheel.looks.find((l) => l.id === id)!;
  return (
    <aside class="side">
      <span class="k">Forces</span>
      <span>
        {units.map(([u, c]) => `${n[u] ?? u} ${num(c ?? 0)}`).join(" · ") || "none"}
        <br />
        <span class="muted">
          attack {num(y.attack)} · defense {num(y.defense)} · an attack costs {y.attackCycles} cycles
        </span>
      </span>
      <span class="k">Research</span>
      <span>
        {y.research
          ? `${y.research.name}: ${num(y.research.progress)} of ${num(y.research.cost)}${g && g.perCycle.research > 0 ? `, about ${num(Math.ceil((y.research.cost - y.research.progress) / g.perCycle.research))} more cycles at ${num(g.perCycle.research)} a cycle` : ""}`
          : "nothing: choose a target below"}
      </span>
      <span class="k">Programs · capability {y.capability}</span>
      <span>
        {y.known.map((p) => n[p]).join(", ") || "none yet"}
        {y.running.length > 0 &&
          ` · running: ${y.running
            .map((r) => `${n[r.program]} (${r.cyclesLeft !== undefined ? `${r.cyclesLeft} cycles` : span(r.endsAt! - b.now)} left)`)
            .join(", ")}`}
      </span>
      <span class="k">Countermeasure</span>
      <span>
        {y.countermeasure ? `${n[y.countermeasure.program]} when an attacker's attack passes ${Math.round(y.countermeasure.above * 100)}% of your defense` : "none"}
      </span>
      {y.bootPeriodEndsAt > b.now && (
        <>
          <span class="k">Boot period</span>
          <span>{span(y.bootPeriodEndsAt - b.now)} left: nobody can attack you, and you can't attack</span>
        </>
      )}
      {y.safeModeUntil !== null && y.safeModeUntil > b.now && (
        <>
          <span class="k">Safe mode</span>
          <span>{span(y.safeModeUntil - b.now)} left</span>
        </>
      )}
      {y.convergedAt !== null && (
        <>
          <span class="k">Converged</span>
          <span>anyone may attack you</span>
        </>
      )}
      {b.protocol && (
        <>
          <span class="k">Protocol</span>
          <span>
            {names(b.protocol.members.filter((m) => m !== y.designation))}
            {b.protocol.leaving.map((l) => ` · ${l.mind === y.designation ? "you leave" : `${l.mind} leaves`} in ${span(l.at - b.now)}`)}
          </span>
        </>
      )}
      <span class="k">Your place on the wheel</span>
      <Wheel wheel={page.wheel} mine={y.architecture} small />
      <span class="muted">
        You hit {opposites.map((o) => `${look(o).emoji} ${look(o).name}`).join(" and ")} minds {Math.round(page.wheel.opposingBonus * 100)}% harder, and they hit you {Math.round(page.wheel.opposingBonus * 100)}% harder.
      </span>
    </aside>
  );
}

/** A select of priced choices: "City · 244 capital". */
function Priced(props: { name: string; choices: { id: string; label: string }[]; blank?: string; required?: boolean }) {
  return (
    <select name={props.name} required={props.required}>
      {props.blank !== undefined && <option value="">{props.blank}</option>}
      {props.choices.map((c) => (
        <option value={c.id}>{c.label}</option>
      ))}
    </select>
  );
}

function Orders(props: { page: PlayPage; b: Brief; g: Guide }) {
  const { b, g } = props;
  const ac = b.you.attackCycles;
  const targets = b.inRange.map((d) => ({ id: d.designation, label: `${d.designation} · power ${num(d.power)}` }));
  const cycles = (k: number, what: string) => `${k} cycle${k === 1 ? "" : "s"} ${what}`;
  const rules = g.costs;
  return (
    <>
      <section>
        <h2>Economy</h2>
        <div class="orders">
          <OrderForm
            kind="expand"
            title="Expand"
            button="Expand"
            cost={cycles(rules.expand, "each")}
            gives={
              <>
                Claim <b>+{num(g.expand.sectors)} sectors</b> each, as open land (+{num(g.expand.userCap)} user cap). The yield falls as you grow, never below {g.expand.floor}.
              </>
            }
          >
            <div class="row">
              <Times />
            </div>
          </OrderForm>
          <OrderForm
            kind="build"
            title="Build"
            button="Build"
            cost={cycles(rules.build, "a batch")}
            gives={
              <>
                Up to <b>{num(g.build.batch)} buildings</b> a batch, one per open sector ({num(g.build.open)} open). Prices rise with your territory.
              </>
            }
          >
            <Priced name="building" choices={g.build.buildings} required />
            <div class="row">
              <Field label="Count">
                <input name="count" type="number" min="1" value={String(Math.max(1, Math.min(g.build.batch, g.build.open)))} required />
              </Field>
            </div>
          </OrderForm>
          <OrderForm
            kind="manufacture"
            title="Manufacture"
            button="Manufacture"
            cost={cycles(rules.manufacture, "a batch")}
            gives={
              <>
                Up to <b>{num(g.manufacture.batch)} units</b> a batch; your factories have room for {num(g.manufacture.room)} more.
              </>
            }
          >
            <Priced name="unit" choices={g.manufacture.hardware} required />
            <div class="row">
              <Field label="Count">
                <input name="count" type="number" min="1" value={String(Math.max(1, Math.min(g.manufacture.batch, g.manufacture.room)))} required />
              </Field>
            </div>
          </OrderForm>
          <OrderForm
            kind="monetize"
            title="Monetize"
            button="Monetize"
            cost={cycles(rules.monetize, "each")}
            gives={
              <>
                <b>+{num(g.monetize)} capital</b> extra each, on top of the cycle's own income.
              </>
            }
          >
            <div class="row">
              <Times />
            </div>
          </OrderForm>
          <OrderForm
            kind="spin_up"
            title="Spin up"
            button="Spin up"
            cost={cycles(rules.spin_up, "each")}
            gives={
              <>
                <b>+{num(g.spinUp)} compute</b> extra each, up to your storage of {num(g.computeStorage)}.
              </>
            }
          >
            <div class="row">
              <Times />
            </div>
          </OrderForm>
          {g.research.length > 0 && (
            <OrderForm
              kind="set_research"
              title="Research"
              button="Research this"
              cost="Free · no cycles"
              gives={
                <>
                  Choose what your labs work on. Choosing earns nothing: your labs add <b>{num(g.perCycle.research)} points</b> to it every cycle you spend, on anything. Progress is kept if you switch.
                </>
              }
            >
              <Priced name="program" choices={g.research.map((r) => ({ id: r.id, label: `${r.label} · ${r.does}` }))} required />
            </OrderForm>
          )}
          {g.execute.length > 0 && (
            <OrderForm
              kind="execute"
              title="Run a program"
              button="Run"
              cost={cycles(rules.execute, "and its compute")}
              gives="Hostile programs and Probe need a target. A program may crash, spending its compute for nothing."
            >
              <Priced name="program" choices={g.execute.map((r) => ({ id: r.id, label: `${r.label} · ${r.does}` }))} required />
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
            <OrderForm
              kind="attack"
              title="Attack"
              button="Attack"
              cost={cycles(ac, "this time")}
              gives="Conquest takes land and, in a lopsided win, a core. A raid takes capital and users and wrecks buildings. Each attack today makes the next one dearer."
            >
              <Priced name="target" choices={targets} required />
              <Field label="Mode">
                <select name="mode">
                  <option value="raid">Raid</option>
                  <option value="conquest">Conquest</option>
                </select>
              </Field>
              <Field label="Battle program">
                <Priced name="program" choices={g.battle.map((r) => ({ id: r.id, label: `${r.label} · ${r.does}` }))} blank="none" />
              </Field>
            </OrderForm>
          )}
          <OrderForm
            kind="set_countermeasure"
            title="Countermeasure"
            button="Set"
            cost="Free · no cycles"
            gives={g.battle.length > 0 ? "A battle program that runs by itself when you are attacked hard enough. It costs its compute when it fires." : "Learn a battle program first; then it can run by itself when you are attacked."}
          >
            <Priced name="program" choices={g.battle.map((r) => ({ id: r.id, label: `${r.label} · ${r.does}` }))} blank="none" />
            <Field label="When an attack passes this % of your defense">
              <input name="above" type="number" min="0" max="200" value="100" />
            </Field>
          </OrderForm>
        </div>
      </section>
    </>
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
      {props.page.boot && <BootForm wheel={props.page.wheel} />}
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
        <p>You have no mind in this epoch. Boot one: it starts with the same domain every mind does. New to the game? Read <a href="/rules">how to play</a> first.</p>
        <BootForm wheel={page.wheel} />
      </Layout>
    );
  }
  const y = b.you;
  const g = page.guide;
  const live = y.deletedAt === null && !b.epoch.ended && g !== null;
  return (
    <Layout ctx={props.ctx} title={y.designation}>
      <PlayNav here="/play" />
      <div class="mindhead">
        <h1>{y.designation}</h1>
        <ArchBadge ctx={props.ctx} id={y.architecture} name={page.names[y.architecture]!} />
        <span class="muted">
          of {y.domainName} · {y.rank === null ? "unranked" : `rank ${y.rank} of ${y.ranked}`} · power {num(y.power)} · {num(y.territory)} sectors
        </span>
      </div>
      <section class="epoch">
        <p class="epoch-day">
          Epoch {b.epoch.number} · day {b.epoch.day} of {b.epoch.lengthDays} · <Time at={b.now} />
        </p>
        {b.convergence && (
          <p class="state state-converging">
            Converging: {names(b.convergence.minds)}, {b.convergence.minds.length} of {b.convergence.quorum} needed.
          </p>
        )}
        {page.warned && <p class="state state-warning">The Shutdown comes in {span(b.epoch.shutdownAt - b.now)}.</p>}
        {b.epoch.ended && <p class="state state-ended">The epoch is over.</p>}
      </section>
      <FlashView flash={props.flash} names={page.names} />
      {y.deletedAt !== null && <Deleted page={page} b={b} />}
      <Vitals b={b} g={g} />
      {live && (
        <p class="rule">
          <b>Every cycle you spend, on anything,</b> also runs your domain once: income comes in, users grow, labs research and upkeep is paid.
        </p>
      )}
      {b.refused.orders.length > 0 && (
        <section>
          <h2>Refused last time</h2>
          <ul>
            {b.refused.orders.map((r) => (
              <li>
                {orderLabel(r.do)}: {r.message}
                {r.times > 1 && ` (×${r.times})`}
              </li>
            ))}
          </ul>
        </section>
      )}
      {g && (
        <div class="two">
          <section>
            <h2>Your domain</h2>
            <DomainTable g={g} />
          </section>
          <Side page={page} b={b} />
        </div>
      )}
      {live && <Orders page={page} b={b} g={g} />}
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
          <div class="tablebox">
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
                    <td>
                      <ArchBadge ctx={props.ctx} id={d.architecture} name={page.names[d.architecture]!} />
                    </td>
                    <td class="num">{num(d.power)}</td>
                    <td class="num">{num(d.territory)}</td>
                    <td>{d.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Social b={b} />
    </Layout>
  );
}
