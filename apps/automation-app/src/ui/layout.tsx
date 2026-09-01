import type { Element } from './element.js';

/**
 * The shell every screen is served in.
 *
 * The stylesheets and the script are named per page rather than bundled into one
 * global include: the detail screen has no replay on it, and a page that pulled in the
 * timeline's script would start fetching a timeline nobody asked for.
 */
export function Layout(props: {
  title: string;
  styles?: readonly string[];
  script?: string;
  children?: unknown;
}): Element {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {(props.styles ?? []).map((href) => <link rel="stylesheet" href={href} />)}
        {props.script ? <script type="module" src={props.script} /> : null}
      </head>
      <body>
        <nav class="app-nav">
          <a href="/activity">タイムライン</a>
          <a href="/work-definitions/new">新しい作業を定義する</a>
        </nav>
        {props.children}
      </body>
    </html>
  );
}

/** Hono JSX renders a fragment; the doctype is prepended once, here. */
export async function renderDocument(element: Element): Promise<string> {
  return `<!doctype html>${String(await element)}`;
}
