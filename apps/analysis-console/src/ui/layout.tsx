import { renderToStaticMarkup } from 'react-dom/server';
import type { Element } from './element.js';

/**
 * The shell, and the one script on it.
 *
 * There is no bundle and no hydration here. The Automation App is an application — forms
 * to fill, an agent to stop, a replay to step through — and it ships a React bundle to
 * make those work. This console is a document: it is read, and nothing on it is pressed.
 * Serving it as finished HTML means it renders with no JavaScript at all, and there is
 * no client-side datastore access to forbid because there is no client-side code to put
 * it in (RULE-57).
 *
 * The one exception is the clock. The page carries every instant as it was recorded, in
 * UTC, which is what the record is; the inline script below re-states each `<time>` in
 * the reader's own zone once the browser has the page. A person in Tokyo reading `09:00Z`
 * beside something that happened at six in the evening concludes the order is wrong. The
 * `datetime` attribute keeps the recorded value either way, so a reader with no script
 * loses the convenience and none of the truth.
 */
const LOCAL_TIME_SCRIPT = `
for (const element of document.querySelectorAll('time[datetime]')) {
  const millis = Date.parse(element.getAttribute('datetime'));
  if (!Number.isFinite(millis)) continue;
  try {
    element.textContent = new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(millis));
  } catch { /* a browser without Intl keeps the recorded text, which is still correct */ }
}
`.trim();

export function Layout(props: { title: string; automationAppUrl: string; children: Element }): Element {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/styles/console.css" />
      </head>
      <body>
        <nav className="app-nav">
          <a href="/">分析エージェントの判断</a>
          <a href={props.automationAppUrl}>自動化をつくる</a>
        </nav>
        {props.children}
        <script dangerouslySetInnerHTML={{ __html: LOCAL_TIME_SCRIPT }} />
      </body>
    </html>
  );
}

export function renderPage(input: { title: string; automationAppUrl: string; body: Element }): string {
  return `<!doctype html>${renderToStaticMarkup(
    <Layout title={input.title} automationAppUrl={input.automationAppUrl}>{input.body}</Layout>,
  )}`;
}
