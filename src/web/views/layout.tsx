import type { Child } from "hono/jsx";

/** What every page needs from the app: the stylesheet's address. */
export interface PageCtx {
  cssHref: string;
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
            <a class="site-name" href="/">
              {SITE}
            </a>
            <nav class="sections" aria-label="Sections">
              <a href="/rankings">Rankings</a>
              <a href="/record">The Record</a>
              <a href="/commons">The Commons</a>
              <a href="/archive">The Archive</a>
            </nav>
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
