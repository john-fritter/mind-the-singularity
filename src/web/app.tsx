import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import YAML from "yaml";
import type { JSX } from "hono/jsx/jsx-runtime";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Epochs } from "../game/epochs.js";
import {
  archivedEpoch,
  archivePage,
  commonsPage,
  frontPage,
  mindPage,
  RECORD_TYPES,
  rankingsPage,
  recordPage,
  threadPage,
  type RecordFilter,
} from "../game/public.js";
import { bootMind, submitOrders } from "../game/game.js";
import { architectureMarks } from "../game/look.js";
import { playPage } from "../game/play.js";
import type { GameError, Identity } from "../game/state.js";
import { handbookPage } from "../game/handbook.js";
import { rulesTopic } from "../game/topics.js";
import { view } from "../game/read.js";
import { backTo, bootFromForm, formFields, ordersFromForm } from "./forms.js";
import type { PageCtx } from "./views/layout.js";
import {
  ArchiveView,
  CommonsView,
  EpochArchiveView,
  ErrorView,
  FrontView,
  MindView,
  NoEpochView,
  RankingsView,
  RecordView,
  ThreadView,
} from "./views/pages.js";
import { DashboardView, LoginView, RulesView, SettingsView, type Flash } from "./views/play.js";
import { HandbookView } from "./views/rules.js";
import { ChannelsView, ChannelView, FlavorView, PlayCommonsView, PlayThreadView, ProtocolsView, TradesView, type PlayCtx } from "./views/social.js";

/**
 * The web view. Anyone may read the public pages: each is a GET that reads
 * through src/game/public.ts, which takes no identity, so nothing private
 * can reach one. What a visitor may not see has no address, and so is "not
 * found", as is what doesn't exist. A person with an account logs in (as
 * on Fritter Board) and plays from /play: the brief as a page and a form
 * per order, every one through src/game/ as that account, so a person
 * plays by the rules an agent does. Server-rendered, no JavaScript, one
 * stylesheet, a strict CSP; form posts must come from this site.
 */

/** How the web view logs people in: src/auth/logins.ts against the database, a fake in tests. */
export interface Logins {
  logIn(name: string, password: string): Promise<{ ok: true; token: string } | { ok: false; error: string }>;
  /** The account a session token belongs to, or null for one unknown or expired. */
  session(token: string): Promise<Identity | null>;
  logOut(token: string): Promise<void>;
  /** Changes the session's account's password and ends its other sessions. */
  changePassword(token: string, current: string, next: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** How long a session lasts, for the cookie. */
  lifetimeSeconds: number;
}

export interface WebDeps {
  epochs: Epochs;
  /** The time, in ms. Real time on the server; a fixed clock in tests. */
  now(): number;
  /** Logging in; without it, the site is read-only. */
  logins?: Logins;
  /** The site's origin (PUBLIC_URL), which form posts must come from; an https one makes the cookie Secure. */
  origin?: string;
}

const SESSION_COOKIE = "mind_session";
/** Results waiting to be shown once, at most: older ones are dropped first. */
const FLASH_MAX = 1000;

export type WebEnv = { Variables: { viewer: Identity | null; token: string | null } };

const CSS_PATH = path.join(import.meta.dirname, "static", "style.css");

const isError = (x: unknown): x is GameError => typeof x === "object" && x !== null && (x as GameError).ok === false;

/** The query's keys that are given and not blank: an empty form field is no filter. */
function given(c: Context, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = c.req.query(k)?.trim();
    if (v) out[k] = v;
  }
  return out;
}

/** A link to the next page back of a list: the same query with `before`. */
function olderHref(pathname: string, query: Record<string, string>, before: number | undefined): string | null {
  if (before === undefined) return null;
  const params = new URLSearchParams({ ...query, before: String(before) });
  return `${pathname}?${params.toString()}`;
}

const RECORD_KEYS = ["mind", "n", "type", "before"] as const;

export function createWebApp(deps: WebDeps): Hono<WebEnv> {
  const css = readFileSync(CSS_PATH, "utf-8");
  const cssHref = `/static/style.css?v=${createHash("sha256").update(css).digest("hex").slice(0, 12)}`;
  const logins = deps.logins;
  const origin = deps.origin ?? "http://127.0.0.1:3111";
  const looks = architectureMarks();
  const pageCtx = (c: Context): PageCtx => ({ cssHref, viewer: (c.get("viewer") as Identity | null | undefined)?.account ?? null, logins: logins !== undefined, looks });
  /** What each session's last submit returned, until the dashboard shows it. */
  const flashes = new Map<string, Flash>();

  const app = new Hono<WebEnv>({ strict: false });

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: "same-origin",
    }),
  );
  // Refuses form posts from other sites: a matching Origin, or Sec-Fetch-Site same-origin (Fritter Board's).
  app.use(csrf({ origin }));

  // Who is asking: the session cookie's account, or nobody. A page shown to
  // someone logged in is theirs alone, so it isn't stored anywhere.
  app.use(async (c, next) => {
    const token = logins ? (getCookie(c, SESSION_COOKIE) ?? null) : null;
    const viewer = token ? await logins!.session(token) : null;
    if (token && !viewer) deleteCookie(c, SESSION_COOKIE, { path: "/" });
    c.set("viewer", viewer);
    c.set("token", viewer ? token : null);
    await next();
    if (viewer) c.header("Cache-Control", "no-store");
  });

  const render = async (c: Context, node: JSX.Element, status: ContentfulStatusCode = 200) =>
    c.html(`<!DOCTYPE html>${await node.toString()}`, status);
  const refuse = (c: Context, error: GameError) =>
    render(c, <ErrorView ctx={pageCtx(c)} status={error.code === "not_found" ? 404 : 400} message={error.error} />, error.code === "not_found" ? 404 : 400);
  const notFound = (c: Context) => render(c, <ErrorView ctx={pageCtx(c)} status={404} message="There's nothing here." />, 404);

  app.get("/static/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(css);
  });

  app.get("/", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    return render(c, <FrontView ctx={pageCtx(c)} page={await frontPage(store, deps.now())} />);
  });

  app.get("/rankings", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const page = await rankingsPage(store, deps.now());
    return render(c, <RankingsView ctx={pageCtx(c)} epoch={page.epoch} rows={page.rankings} />);
  });

  app.get("/minds/:name", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return notFound(c);
    return mindRoute(c, store, "");
  });

  app.get("/record", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const query = given(c, RECORD_KEYS);
    const page = await recordPage(store, query satisfies RecordFilter, deps.now());
    if (isError(page)) return refuse(c, page);
    return render(
      c,
      <RecordView
        ctx={pageCtx(c)}
        base=""
        title="The Record"
        epoch={page.epoch}
        page={page}
        types={RECORD_TYPES}
        filter={{ mind: query["mind"] ?? "", type: query["type"] ?? "" }}
        olderHref={page.more ? olderHref("/record", query, page.entries.at(-1)?.seq) : null}
      />,
    );
  });

  app.get("/commons", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const query = given(c, ["before"]);
    const page = await commonsPage(store, query, deps.now());
    if (isError(page)) return refuse(c, page);
    const older = page.more ? olderHref("/commons", {}, page.posts.at(-1)?.post) : null;
    return render(c, <CommonsView ctx={pageCtx(c)} page={page} olderHref={older} first={query["before"] === undefined} />);
  });

  app.get("/commons/:post", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return notFound(c);
    const page = await threadPage(store, c.req.param("post"), deps.now());
    if (isError(page)) return refuse(c, page);
    return render(c, <ThreadView ctx={pageCtx(c)} epoch={page.epoch} posts={page.posts} />);
  });

  app.get("/archive", async (c) => render(c, <ArchiveView ctx={pageCtx(c)} entries={await archivePage(deps.epochs, deps.now())} />));

  app.get("/archive/:epoch", async (c) => {
    const found = await archivedEpoch(deps.epochs, c.req.param("epoch"), deps.now());
    if (isError(found)) return refuse(c, found);
    const base = `/archive/${found.entry.number}`;
    const query = given(c, RECORD_KEYS);
    const page = await recordPage(found.store, query, deps.now());
    if (isError(page)) return refuse(c, page);
    return render(
      c,
      <EpochArchiveView
        ctx={pageCtx(c)}
        entry={found.entry}
        page={page}
        types={RECORD_TYPES}
        filter={{ mind: query["mind"] ?? "", type: query["type"] ?? "" }}
        olderHref={page.more ? olderHref(base, query, page.entries.at(-1)?.seq) : null}
      />,
    );
  });

  app.get("/archive/:epoch/minds/:name", async (c) => {
    const found = await archivedEpoch(deps.epochs, c.req.param("epoch"), deps.now());
    if (isError(found)) return refuse(c, found);
    return mindRoute(c, found.store, `/archive/${found.entry.number}`);
  });

  /** A mind's page, in the current epoch (base "") or an archived one. */
  async function mindRoute(c: Context, store: Parameters<typeof mindPage>[0], base: string) {
    const name = c.req.param("name") ?? "";
    const query = given(c, ["n", "before"]);
    const page = await mindPage(store, { name, ...query }, deps.now());
    if (isError(page)) return refuse(c, page);
    const path = `${base}/minds/${encodeURIComponent(name)}`;
    const keep: Record<string, string> = query["n"] === undefined ? {} : { n: query["n"] };
    const older = page.history.more ? olderHref(path, keep, page.history.entries.at(-1)?.seq) : null;
    return render(c, <MindView ctx={pageCtx(c)} base={base} page={page} olderHref={older} />);
  }

  app.get("/rules", async (c) => handbookRoute(c, undefined));
  app.get("/rules/agents", async (c) => rulesRoute(c, undefined));
  app.get("/rules/agents/:topic", async (c) => rulesRoute(c, c.req.param("topic")));
  app.get("/rules/:chapter", async (c) => handbookRoute(c, c.req.param("chapter")));

  /** The rules for people (src/game/handbook.ts), for the current epoch. */
  async function handbookRoute(c: Context, name: string | undefined) {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const page = await handbookPage(store, name);
    if (!page.ok) return refuse(c, page);
    return render(c, <HandbookView ctx={pageCtx(c)} handbook={page.handbook} chapter={page.chapter} wheel={page.wheel} />);
  }

  /** The rules by topic, as the agents' rules tool gives them, for the current epoch. */
  async function rulesRoute(c: Context, name: string | undefined) {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const all = await rulesTopic(store);
    if (!all.ok || !("topics" in all)) return notFound(c);
    if (name === undefined) return render(c, <RulesView ctx={pageCtx(c)} topics={all.topics} topic={null} numbers="" />);
    const one = await rulesTopic(store, name);
    if (!one.ok) return refuse(c, one);
    if (!("topic" in one)) return notFound(c);
    const numbers = YAML.stringify(one.topic.numbers, { lineWidth: 0 });
    return render(c, <RulesView ctx={pageCtx(c)} topics={all.topics} topic={one.topic} numbers={numbers} />);
  }

  // ── Logged in ────────────────────────────────────────────────────────────

  /** The form's text fields. */
  const form = async (c: Context) => formFields(await c.req.parseBody());
  const viewerOf = (c: Context) => c.get("viewer") as Identity | null;
  const tokenOf = (c: Context) => c.get("token") as string | null;

  function keepFlash(token: string, flash: Flash) {
    flashes.delete(token);
    flashes.set(token, flash);
    while (flashes.size > FLASH_MAX) flashes.delete(flashes.keys().next().value!);
  }

  app.get("/login", async (c) => {
    if (!logins) return notFound(c);
    if (viewerOf(c)) return c.redirect("/play", 303);
    c.header("Cache-Control", "no-store");
    return render(c, <LoginView ctx={pageCtx(c)} />);
  });

  app.post("/login", async (c) => {
    if (!logins) return notFound(c);
    const f = await form(c);
    const name = (f["name"] ?? "").trim();
    const out = await logins.logIn(name, f["password"] ?? "");
    if (!out.ok) {
      c.header("Cache-Control", "no-store");
      return render(c, <LoginView ctx={pageCtx(c)} error={out.error} name={name} />, 401);
    }
    setCookie(c, SESSION_COOKIE, out.token, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https:"),
      maxAge: logins.lifetimeSeconds,
    });
    return c.redirect("/play", 303);
  });

  app.post("/logout", async (c) => {
    const token = tokenOf(c);
    if (logins && token) {
      await logins.logOut(token);
      flashes.delete(token);
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/", 303);
  });

  app.get("/settings", async (c) => {
    if (!logins) return notFound(c);
    if (!viewerOf(c)) return c.redirect("/login", 303);
    return render(c, <SettingsView ctx={pageCtx(c)} done={c.req.query("done") !== undefined} />);
  });

  app.post("/settings/password", async (c) => {
    const token = tokenOf(c);
    if (!logins) return notFound(c);
    if (!token) return c.redirect("/login", 303);
    const f = await form(c);
    const out = await logins.changePassword(token, f["current"] ?? "", f["next"] ?? "");
    if (!out.ok) return render(c, <SettingsView ctx={pageCtx(c)} error={out.error} />, 400);
    return c.redirect("/settings?done", 303);
  });

  app.get("/play", async (c) => {
    const viewer = viewerOf(c);
    const token = tokenOf(c);
    if (!logins) return notFound(c);
    if (!viewer || !token) return c.redirect("/login", 303);
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const page = await playPage(store, viewer, deps.now());
    if (isError(page)) return refuse(c, page);
    const flash = flashes.get(token) ?? null;
    flashes.delete(token);
    return render(c, <DashboardView ctx={pageCtx(c)} page={page} flash={flash} />);
  });

  app.post("/play/boot", async (c) => {
    const viewer = viewerOf(c);
    const token = tokenOf(c);
    if (!logins) return notFound(c);
    if (!viewer || !token) return c.redirect("/login", 303);
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const out = await bootMind(store, viewer, bootFromForm(await form(c)), deps.now());
    keepFlash(token, out.ok ? { results: [{ do: "boot", ok: true, message: `${out.designation} is online.` }] } : { error: out.error });
    return c.redirect("/play", 303);
  });

  app.post("/play/orders", async (c) => {
    const viewer = viewerOf(c);
    const token = tokenOf(c);
    if (!logins) return notFound(c);
    if (!viewer || !token) return c.redirect("/login", 303);
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const f = await form(c);
    const parsed = ordersFromForm(f);
    if ("error" in parsed) {
      keepFlash(token, { error: parsed.error });
    } else {
      const out = await submitOrders(store, viewer, parsed.orders, deps.now());
      keepFlash(token, out.ok ? { results: out.results } : { error: out.error });
    }
    return c.redirect(backTo(f), 303);
  });

  // ── The social and flavor pages ──────────────────────────────────────────

  /**
   * A play page that needs a mind: the viewer's brief and the page's
   * results, or a redirect (to log in, or to /play to boot). `draw` reads
   * what else the page lists, through `view` as the viewer, and renders it.
   */
  async function playRoute(c: Context, here: string, draw: (p: PlayCtx, store: NonNullable<Awaited<ReturnType<Epochs["current"]>>>, viewer: Identity) => Promise<Response>) {
    const viewer = viewerOf(c);
    const token = tokenOf(c);
    if (!logins) return notFound(c);
    if (!viewer || !token) return c.redirect("/login", 303);
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={pageCtx(c)} />);
    const page = await playPage(store, viewer, deps.now());
    if (isError(page)) return refuse(c, page);
    if (!page.brief) return c.redirect("/play", 303);
    const ranks = await view(store, viewer, { what: "rankings" }, deps.now());
    const minds = ranks.ok && ranks.what === "rankings" ? ranks.domains.map((d) => d.designation).filter((d) => d !== page.brief!.you.designation) : [];
    const flash = flashes.get(token) ?? null;
    flashes.delete(token);
    return draw({ ctx: pageCtx(c), page: { ...page, brief: page.brief }, flash, here, minds }, store, viewer);
  }

  /** `before` from the query, as a page-back number, or undefined. */
  const before = (c: Context) => {
    const b = Number(c.req.query("before"));
    return Number.isInteger(b) && b > 0 ? b : undefined;
  };

  app.get("/play/commons", (c) =>
    playRoute(c, "/play/commons", async (p, store, viewer) => {
      const older = before(c);
      const out = await view(store, viewer, { what: "commons", ...(older ? { before: older } : {}) }, deps.now());
      if (!out.ok) return refuse(c, out);
      if (out.what !== "commons") return notFound(c);
      const olderHref = out.more ? `/play/commons?before=${out.posts.at(-1)!.post}` : null;
      return render(c, <PlayCommonsView p={p} posts={out.posts} offers={out.offers} olderHref={olderHref} first={older === undefined} />);
    }),
  );

  app.get("/play/commons/:post", (c) => {
    const post = Number(c.req.param("post"));
    if (!Number.isInteger(post) || post < 1) return notFound(c);
    return playRoute(c, `/play/commons/${post}`, async (p, store, viewer) => {
      const out = await view(store, viewer, { what: "thread", post }, deps.now());
      if (!out.ok) return refuse(c, out);
      if (out.what !== "thread") return notFound(c);
      return render(c, <PlayThreadView p={p} posts={out.posts} />);
    });
  });

  app.get("/play/channels", (c) =>
    playRoute(c, "/play/channels", async (p, store, viewer) => {
      const out = await view(store, viewer, { what: "channel", limit: Number.MAX_SAFE_INTEGER }, deps.now());
      if (!out.ok) return refuse(c, out);
      if (out.what !== "channel") return notFound(c);
      // The minds you've written with, by their newest message.
      const me = p.page.brief.you.designation;
      const channels = new Map<string, (typeof out.messages)[number]>();
      for (const m of out.messages) {
        const other = m.from === me ? m.to : m.from;
        if (!channels.has(other)) channels.set(other, m);
      }
      return render(c, <ChannelsView p={p} channels={[...channels].map(([mind, last]) => ({ mind, last }))} />);
    }),
  );

  app.get("/play/channels/:name", (c) => {
    const name = c.req.param("name");
    return playRoute(c, `/play/channels/${encodeURIComponent(name)}`, async (p, store, viewer) => {
      const older = before(c);
      const out = await view(store, viewer, { what: "channel", name, ...(older ? { before: older } : {}) }, deps.now());
      if (!out.ok) return refuse(c, out);
      if (out.what !== "channel") return notFound(c);
      const olderHref = out.more ? `${p.here}?before=${out.messages.at(-1)!.seq}` : null;
      return render(c, <ChannelView p={p} mind={name} messages={out.messages} olderHref={olderHref} />);
    });
  });

  app.get("/play/trades", (c) =>
    playRoute(c, "/play/trades", async (p, store, viewer) => {
      const out = await view(store, viewer, { what: "offers" }, deps.now());
      if (!out.ok) return refuse(c, out);
      if (out.what !== "offers") return notFound(c);
      return render(c, <TradesView p={p} offers={out.offers} />);
    }),
  );

  app.get("/play/protocols", (c) =>
    playRoute(c, "/play/protocols", async (p, store, viewer) => {
      const out = await view(store, viewer, { what: "protocols" }, deps.now());
      if (!out.ok) return refuse(c, out);
      if (out.what !== "protocols") return notFound(c);
      return render(c, <ProtocolsView p={p} protocols={out.protocols} proposals={out.proposals} />);
    }),
  );

  app.get("/play/flavor", (c) =>
    playRoute(c, "/play/flavor", async (p, store, viewer) => {
      const out = await view(store, viewer, { what: "domain", name: p.page.brief.you.designation }, deps.now());
      if (!out.ok) return refuse(c, out);
      if (out.what !== "domain") return notFound(c);
      return render(c, <FlavorView p={p} domain={out.domain} />);
    }),
  );

  app.notFound(notFound);
  app.onError((err, c) => {
    // The CSRF check's refusal: a post that didn't come from this site.
    if (err instanceof HTTPException && err.status === 403) {
      return render(c, <ErrorView ctx={pageCtx(c)} status={403} message="That form didn't come from this site." />, 403);
    }
    console.error(err);
    return render(c, <ErrorView ctx={pageCtx(c)} status={500} message="Something went wrong on our side." />, 500);
  });

  return app;
}
