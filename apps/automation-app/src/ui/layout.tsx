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
  /**
   * The Analysis Console, which is a separate deployment with its own login. It is in
   * the navigation because a person who has just had an agent quarantined has to be
   * able to find out why, and it is an absolute URL because it is another service —
   * this app holds its address and never calls it.
   */
  analysisConsoleUrl: string;
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
          <a href="/">ToDo</a>
          <a href="/activity">タイムライン</a>
          <a href="/security">ログ分析モニター</a>
          <a href={props.analysisConsoleUrl}>分析エージェントの判断</a>
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
export function renderPage(input: {
  title: string;
  analysisConsoleUrl: string;
  styles: readonly string[];
  script: string;
  data: PageData;
}): string {
  return renderDocument(
    <Layout
      title={input.title}
      analysisConsoleUrl={input.analysisConsoleUrl}
      styles={input.styles}
      script={input.script}
      data={input.data}
    >
      <PageRoot data={input.data} />
    </Layout>,
  );
}
