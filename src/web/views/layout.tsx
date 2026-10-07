import type { Child } from "hono/jsx";
import { Sigil } from "./look.js";

/** What every page needs from the app: the stylesheet's address, and who is logged in. */
export interface PageCtx {
  cssHref: string;
  /** The logged-in account's name, or null for a visitor. */
  viewer: string | null;
  /** Whether the logged-in account may see the admin view. */
  admin: boolean;
  /** Whether this site lets people log in at all. */
  logins: boolean;
  /** Each architecture's emoji and color, in wheel order, by id. */
  looks: Record<string, { emoji: string; color: string }>;
}

const SITE = "Mind: the Singularity";

/** The page around every view: masthead, the site's sections, and the footer. No scripts, no inline styles. */
export function Layout(props: { ctx: PageCtx; title?: string; children?: Child }) {
  const title = props.title ? `${props.title} · ${SITE}` : SITE;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{title}</title>
        <link rel="stylesheet" href={props.ctx.cssHref} />
      </head>
      <body>
        <div class="wrap">
          <header class="masthead">
            <a class="brand" href="/">
              <Sigil ctx={props.ctx} />
              <span class="site-name">{SITE}</span>
            </a>
            <nav class="sections" aria-label="Sections">
              <a href="/rankings">Rankings</a>
              <a href="/record">The Record</a>
              <a href="/commons">The Commons</a>
              <a href="/archive">The Archive</a>
              <a href="/rules">Rules</a>
            </nav>
            <Account ctx={props.ctx} />
          </header>
          <main>{props.children}</main>
          <footer class="footer">
            <p>All times are UTC.</p>
          </footer>
        </div>
      </body>
    </html>
  );
}

/** The masthead's corner: log in, or the account's own pages and log out (a POST, so another site can't do it). */
function Account(props: { ctx: PageCtx }) {
  if (!props.ctx.logins) return null;
  if (props.ctx.viewer === null) {
    return (
      <nav class="account" aria-label="Account">
        <a href="/login">Log in</a>
      </nav>
    );
  }
  return (
    <nav class="account" aria-label="Account">
      <a href="/play">Play</a>
      {props.ctx.admin && <a href="/admin">Admin</a>}
      <a href="/settings">{props.ctx.viewer}</a>
      <form method="post" action="/logout" class="inline">
        <button type="submit">Log out</button>
      </form>
    </nav>
  );
}
