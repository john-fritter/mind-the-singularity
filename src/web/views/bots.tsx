import { REASONING_EFFORTS, type BotPage, type BotRow, type BotRun, type BotsOverview, type ConfigChange, type Tunables } from "../../game/bots.js";
import { num } from "../format.js";
import { Time } from "./components.js";
import { Layout, type PageCtx } from "./layout.js";

// The bot runner's pages in the admin view (phase 6b): every bot's model,
// schedule and spend, and one bot's settings form, wakes and change log.
// src/game/bots.ts decides who sees them; these only lay them out.

function BotsNav(props: { here: string }) {
  const links: [string, string][] = [
    ["/admin", "Minds"],
    ["/admin/bots", "Bots"],
  ];
  return (
    <nav class="play-nav" aria-label="Admin">
      {links.map(([href, label]) => (href === props.here ? <strong>{label}</strong> : <a href={href}>{label}</a>))}
    </nav>
  );
}

const botHref = (name: string) => `/admin/bots/${encodeURIComponent(name)}`;

function tokens(r: BotRun): number {
  return r.promptTokens + r.completionTokens;
}

function ordersOk(r: BotRun): string {
  const results = (r.detail?.results as { results?: { ok: boolean }[] } | null | undefined)?.results;
  if (!results) return "";
  return `${results.filter((x) => x.ok).length}/${results.length}`;
}

function Outcome(props: { run: BotRun }) {
  const r = props.run;
  return (
    <>
      {r.outcome}
      {r.booted ? ", booted" : ""}
      {r.error ? <span class="muted"> ({r.error})</span> : null}
    </>
  );
}

function schedule(t: Tunables): string {
  return `${t.wakes_per_day} a day, ${t.window}`;
}

function BotsTable(props: { rows: BotRow[] }) {
  return (
    <div class="scroll">
      <table class="rankings">
        <thead>
          <tr>
            <th scope="col">Bot</th>
            <th scope="col">Model</th>
            <th scope="col">Reasoning</th>
            <th scope="col">Schedule</th>
            <th scope="col" class="num">
              Tokens today
            </th>
            <th scope="col">Last wake</th>
            <th scope="col">Next wake</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((b) => {
            const t = b.tunables;
            return (
              <tr class={t?.paused ? "legacy" : undefined}>
                <td>
                  <a href={botHref(b.name)}>{b.name}</a>
                </td>
                <td>{t ? t.model : <span class="error">invalid: {b.invalid}</span>}</td>
                <td>{t?.reasoning_effort ?? ""}</td>
                <td>{t ? schedule(t) : ""}</td>
                <td class="num">
                  {num(b.spent)}
                  {t?.daily_tokens != null ? ` of ${num(t.daily_tokens)}` : ""}
                </td>
                <td>
                  {b.last ? (
                    <>
                      <Time at={b.last.at} />: {b.last.outcome}
                    </>
                  ) : (
                    "none yet"
                  )}
                </td>
                <td>{t?.paused ? "paused" : b.next !== null ? <Time at={b.next} /> : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunsTable(props: { runs: BotRun[]; showBot: boolean }) {
  if (props.runs.length === 0) return <p class="muted">No wakes yet.</p>;
  return (
    <div class="scroll">
      <table class="rankings">
        <thead>
          <tr>
            <th scope="col">When</th>
            {props.showBot && <th scope="col">Bot</th>}
            <th scope="col">Outcome</th>
            <th scope="col">Model</th>
            <th scope="col" class="num">
              Calls
            </th>
            <th scope="col" class="num">
              Tokens
            </th>
            <th scope="col" class="num">
              Orders ok
            </th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((r) => (
            <tr>
              <td>
                <Time at={r.at} />
                {r.slot === null ? " (by hand)" : ""}
              </td>
              {props.showBot && (
                <td>
                  <a href={botHref(r.bot)}>{r.bot}</a>
                </td>
              )}
              <td>
                <Outcome run={r} />
              </td>
              <td>{r.model ?? ""}</td>
              <td class="num">{r.modelCalls}</td>
              <td class="num">{num(tokens(r))}</td>
              <td class="num">{ordersOk(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BotsOverviewView(props: { ctx: PageCtx; page: BotsOverview }) {
  const p = props.page;
  return (
    <Layout ctx={props.ctx} title="Admin: bots">
      <h1>Bots</h1>
      <p class="muted">Admin view: the bot runner's settings and wakes. Only accounts with the admin flag see these pages.</p>
      <BotsNav here="/admin/bots" />
      <p>
        {p.day} ({p.timezone}): {num(p.total)} of {num(p.budget)} tokens spent across all bots. Wakes stop for the day once the budget is spent.
      </p>
      {p.bots.length === 0 ? <p class="muted">No bots yet: the runner adds config/runner.yaml's bots when it starts.</p> : <BotsTable rows={p.bots} />}
      <h2>Latest wakes</h2>
      <RunsTable runs={p.recent} showBot />
    </Layout>
  );
}

function SettingsForm(props: { name: string; t: Tunables }) {
  const t = props.t;
  return (
    <form method="post" action={botHref(props.name)} class="stack">
      <label>
        Model <input name="model" value={t.model} required />
      </label>
      <label>
        Fallback models, comma-separated <input name="fallback_models" value={t.fallback_models.join(", ")} />
      </label>
      <label>
        Reasoning{" "}
        <select name="reasoning_effort">
          {REASONING_EFFORTS.map((e) => (
            <option value={e} selected={e === t.reasoning_effort}>
              {e === "default" ? "default (send none)" : e}
            </option>
          ))}
        </select>
      </label>
      <label class="check">
        <input type="checkbox" name="json_mode" value="on" checked={t.json_mode} /> JSON mode
      </label>
      <label>
        Wakes a day <input name="wakes_per_day" type="number" min="1" max="96" value={String(t.wakes_per_day)} required />
      </label>
      <label>
        Waking window <input name="window" value={t.window} required />
      </label>
      <label>
        Daily token cap, blank for none <input name="daily_tokens" value={t.daily_tokens === null ? "" : String(t.daily_tokens)} />
      </label>
      <label class="check">
        <input type="checkbox" name="paused" value="on" checked={t.paused} /> Paused
      </label>
      <button type="submit">Save</button>
    </form>
  );
}

function show(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (v === null) return "none";
  return String(v);
}

function ChangeLog(props: { name: string; changes: ConfigChange[] }) {
  if (props.changes.length === 0) return <p class="muted">No changes yet.</p>;
  return (
    <ul class="adminlog">
      {props.changes.map((c) => (
        <li>
          <Time at={c.at} /> by {c.by}
          {c.undoes !== null ? ` (undoing change ${c.undoes})` : ""}:{" "}
          {Object.entries(c.changes)
            .map(([k, v]) => `${k} ${show(v.from)} → ${show(v.to)}`)
            .join("; ")}{" "}
          <form method="post" action={`${botHref(props.name)}/undo`} class="inline">
            <input type="hidden" name="change" value={String(c.id)} />
            <button type="submit">Undo</button>
          </form>
        </li>
      ))}
    </ul>
  );
}

function RunDetail(props: { run: BotRun }) {
  const r = props.run;
  const d = r.detail;
  if (!d || r.outcome === "skipped") return null;
  return (
    <details>
      <summary>
        <Time at={r.at} />: <Outcome run={r} />
      </summary>
      {d.note ? <p>Note: {d.note}</p> : null}
      {d.orders ? <pre class="wrapped">{JSON.stringify(d.orders, null, 1)}</pre> : null}
      {d.results ? <pre class="wrapped">{JSON.stringify(d.results, null, 1)}</pre> : null}
      {(d.transcript ?? []).map((m) => (
        <>
          <p class="muted">{m.role}</p>
          <pre class="wrapped">{m.content ?? ""}</pre>
        </>
      ))}
    </details>
  );
}

export function BotView(props: { ctx: PageCtx; page: BotPage; error?: string; saved?: boolean }) {
  const p = props.page;
  const b = p.bot;
  return (
    <Layout ctx={props.ctx} title={`Admin: bot ${b.name}`}>
      <h1>Bot {b.name}</h1>
      <BotsNav here="" />
      <p>
        Today ({p.day}, {p.timezone}): {b.ran} wake{b.ran === 1 ? "" : "s"} run or skipped, {num(b.spent)} tokens
        {b.tunables?.daily_tokens != null ? ` of its ${num(b.tunables.daily_tokens)}` : ""}.{" "}
        {b.tunables?.paused ? "Paused." : b.next !== null ? <>Next wake <Time at={b.next} />.</> : null}
      </p>
      <h2>Settings</h2>
      <p class="muted">A change takes effect on the bot's next wake. Persona, boot settings and keys are in config/runner.yaml and runner.env.</p>
      {props.error && <p class="error">{props.error}</p>}
      {props.saved && <p class="ok">Saved.</p>}
      {b.invalid && <p class="error">The stored settings don't read as valid ({b.invalid}); saving the form replaces them.</p>}
      <SettingsForm name={b.name} t={b.tunables ?? { model: "", fallback_models: [], reasoning_effort: "default", json_mode: false, wakes_per_day: 8, window: "00:00-24:00", daily_tokens: null, paused: true }} />
      <h2>Changes</h2>
      <ChangeLog name={b.name} changes={p.changes} />
      <h2>Wakes</h2>
      <RunsTable runs={p.runs} showBot={false} />
      {p.runs.map((r) => (
        <RunDetail run={r} />
      ))}
    </Layout>
  );
}
