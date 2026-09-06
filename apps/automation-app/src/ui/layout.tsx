import { renderToString } from 'react-dom/server';
import { PAGE_DATA_ID, ROOT_ID, serialisePageData, type PageData } from './page-data.js';
import { PageRoot } from './page-root.js';
import type { Element } from './element.js';

/**
 * The shell every screen is served in.
 *
 * The stylesheets are named per page rather than pulled in wholesale, and there is one
 * script: the four screens are one React application now, and four bundles that each
 * carried their own copy of the framework would be four copies of it to download. The
 * page decides what to render from the value in `#page-data`, so a screen still runs
 * only its own code.
 */
export function Layout(props: {
  title: string;
  styles?: readonly string[];
  script?: string;
  data?: PageData;
  children?: React.ReactNode;
}): Element {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {(props.styles ?? []).map((href) => <link key={href} rel="stylesheet" href={href} />)}
        {props.script ? <script type="module" src={props.script} defer /> : null}
      </head>
      <body>
        <nav className="app-nav">
          <a href="/">自動化をつくる</a>
          <a href="/activity">タイムライン</a>
          <a href="/guide">使い方</a>
        </nav>
        <div id={ROOT_ID}>{props.children}</div>
        {props.data
          ? (
            <script
              id={PAGE_DATA_ID}
              type="application/json"
              dangerouslySetInnerHTML={{ __html: serialisePageData(props.data) }}
            />
          )
          : null}
      </body>
    </html>
  );
}

/** React renders the element; the doctype is prepended once, here. */
export function renderDocument(element: Element): string {
  return `<!doctype html>${renderToString(element)}`;
}

/**
 * One screen, served.
 *
 * Every page route ends here, and every one of them passes the same value twice: once
 * to render the markup and once into the document for the browser to render from.
 * Passing it twice from one place is what keeps the two renders identical — a route
 * that built the props for the server and something slightly different for the client
 * would hydrate onto markup that does not match, and React would throw the server's
 * work away.
 */
export function renderPage(input: { title: string; styles: readonly string[]; script: string; data: PageData }): string {
  return renderDocument(
    <Layout title={input.title} styles={input.styles} script={input.script} data={input.data}>
      <PageRoot data={input.data} />
    </Layout>,
  );
}
