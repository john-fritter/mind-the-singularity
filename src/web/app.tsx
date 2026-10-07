import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
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
import type { GameError } from "../game/state.js";
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

/**
 * The public web view: anyone may read it, nobody signs in (that's 5c).
 * Server-rendered, no JavaScript, one stylesheet, a strict CSP. Every page
 * is a GET that reads through src/game/public.ts, which takes no identity,
 * so nothing private can reach a page. What a visitor may not see has no
 * address, and so is "not found", as is what doesn't exist.
 */

export interface WebDeps {
  epochs: Epochs;
  /** The time, in ms. Real time on the server; a fixed clock in tests. */
  now(): number;
}

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

export function createWebApp(deps: WebDeps): Hono {
  const css = readFileSync(CSS_PATH, "utf-8");
  const ctx: PageCtx = { cssHref: `/static/style.css?v=${createHash("sha256").update(css).digest("hex").slice(0, 12)}` };

  const app = new Hono({ strict: false });

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

  const render = async (c: Context, node: JSX.Element, status: ContentfulStatusCode = 200) =>
    c.html(`<!DOCTYPE html>${await node.toString()}`, status);
  const refuse = (c: Context, error: GameError) =>
    render(c, <ErrorView ctx={ctx} status={error.code === "not_found" ? 404 : 400} message={error.error} />, error.code === "not_found" ? 404 : 400);
  const notFound = (c: Context) => render(c, <ErrorView ctx={ctx} status={404} message="There's nothing here." />, 404);

  app.get("/static/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(css);
  });

  app.get("/", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={ctx} />);
    return render(c, <FrontView ctx={ctx} page={await frontPage(store, deps.now())} />);
  });

  app.get("/rankings", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={ctx} />);
    const page = await rankingsPage(store, deps.now());
    return render(c, <RankingsView ctx={ctx} epoch={page.epoch} rows={page.rankings} />);
  });

  app.get("/minds/:name", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return notFound(c);
    return mindRoute(c, store, "");
  });

  app.get("/record", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return render(c, <NoEpochView ctx={ctx} />);
    const query = given(c, RECORD_KEYS);
    const page = await recordPage(store, query satisfies RecordFilter, deps.now());
    if (isError(page)) return refuse(c, page);
    return render(
      c,
      <RecordView
        ctx={ctx}
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
    if (!store) return render(c, <NoEpochView ctx={ctx} />);
    const query = given(c, ["before"]);
    const page = await commonsPage(store, query, deps.now());
    if (isError(page)) return refuse(c, page);
    const older = page.more ? olderHref("/commons", {}, page.posts.at(-1)?.post) : null;
    return render(c, <CommonsView ctx={ctx} page={page} olderHref={older} first={query["before"] === undefined} />);
  });

  app.get("/commons/:post", async (c) => {
    const store = await deps.epochs.current();
    if (!store) return notFound(c);
    const page = await threadPage(store, c.req.param("post"), deps.now());
    if (isError(page)) return refuse(c, page);
    return render(c, <ThreadView ctx={ctx} epoch={page.epoch} posts={page.posts} />);
  });

  app.get("/archive", async (c) => render(c, <ArchiveView ctx={ctx} entries={await archivePage(deps.epochs, deps.now())} />));

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
        ctx={ctx}
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
    return render(c, <MindView ctx={ctx} base={base} page={page} olderHref={older} />);
  }

  app.notFound(notFound);
  app.onError((err, c) => {
    console.error(err);
    return render(c, <ErrorView ctx={ctx} status={500} message="Something went wrong on our side." />, 500);
  });

  return app;
}
