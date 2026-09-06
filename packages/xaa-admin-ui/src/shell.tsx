import { renderToStaticMarkup } from 'react-dom/server';
import { ADMIN_STYLESHEET_PATH } from './styles.js';
import type { Element } from './element.js';

/** One entry in the bar at the top of every console screen. */
export interface AdminNavLink {
  href: string;
  label: string;
}

/**
 * The shell every admin console screen is served in.
 *
 * There is no bundle and no hydration, and that is a decision rather than an omission.
 * An administrator reaches these services through `gcloud run services proxy`, which
 * attaches their Google identity token to whatever the browser sends; a page whose
 * buttons were JavaScript would be a page whose buttons depend on that proxy behaving
 * the same way for `fetch` as for a form post. Every screen here is therefore a form the
 * browser submits and a table the browser renders, which works with no script at all —
 * and leaves no client-side code for a datastore SDK to hide in (RULE-57).
 *
 * React is still what describes the screens. What it renders is finished HTML rather
 * than markup waiting to be hydrated, which is the same choice the Analysis Console
 * made and for the same reason.
 */
export function AdminShell(props: {
  title: string;
  nav: readonly AdminNavLink[];
  children: Element;
}): Element {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href={ADMIN_STYLESHEET_PATH} />
      </head>
      <body>
        <nav className="admin-nav">
          {props.nav.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
        </nav>
        <h1>{props.title}</h1>
        {props.children}
      </body>
    </html>
  );
}

/** React renders the element; the doctype is prepended once, here. */
export function renderAdminPage(input: {
  title: string;
  nav: readonly AdminNavLink[];
  body: Element;
}): string {
  return `<!doctype html>${renderToStaticMarkup(
    <AdminShell title={input.title} nav={input.nav}>{input.body}</AdminShell>,
  )}`;
}

/**
 * The problems with what somebody typed, all of them, above the form they typed it in.
 *
 * Every console validates totally rather than field by field, so this renders a list
 * rather than a sentence: a form that rejects one field at a time is a form somebody
 * submits five times.
 */
export function AdminErrors(props: { errors: readonly string[] }): Element {
  if (props.errors.length === 0) return null;
  return (
    <div className="errors">
      <ul>{props.errors.map((error) => <li key={error}>{error}</li>)}</ul>
    </div>
  );
}
