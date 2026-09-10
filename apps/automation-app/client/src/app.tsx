import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { readPageData, ROOT_ID } from '../../src/ui/page-data.js';
import { PageRoot } from '../../src/ui/page-root.js';

/**
 * The browser half of every screen, which is one line of work: render the same tree the
 * server already rendered, over the markup it produced.
 *
 * There were four of these, one per screen, each finding elements by attribute and
 * wiring listeners onto them by hand. They were four descriptions of the same pages,
 * kept in step with the server's by hand, and the day one of them fell out of step the
 * page silently lost a button. Now there is one, and the description of a page exists
 * once — in `PageRoot`, which both halves render.
 *
 * `hydrateRoot` rather than `createRoot`: the markup is already correct and already
 * readable, and replacing it would blank the screen for as long as the framework takes
 * to boot. What hydration adds is the parts that need a person — the replay's controls,
 * the forms, the refresh button — and nothing else appears that was not already there.
 *
 * No database SDK is imported here, and none may be (DEV-13): the page talks to this
 * app's REST API and to nothing else.
 */
export function start(document_: Document = document): void {
  const root = document_.getElementById(ROOT_ID);
  const data = readPageData(document_);
  if (!root || !data) return;
  hydrateRoot(root, <StrictMode><PageRoot data={data} /></StrictMode>);
}

if (typeof document !== 'undefined') start();
