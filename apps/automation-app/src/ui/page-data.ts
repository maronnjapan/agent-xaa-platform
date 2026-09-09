import type { AnalysisRun } from '@xaa/contracts';
import type { FaultTrial } from '../agents/faults.js';
import type { AgentStatusResponse } from '../agents/status.js';
import type { TimelineTask } from '../activity/query.js';
import type { HomeAgent, HomeTodoItem } from './pages/home.js';

/**
 * Everything a screen was rendered from, in one serialisable value.
 *
 * The server renders a page and then writes the same value into the document as JSON,
 * so the browser can render the identical tree over the markup it was served rather
 * than replacing it. That is what makes this a React app and still a page that reads
 * correctly with no script at all: the HTML is complete before hydration, and
 * hydration adds the buttons.
 *
 * It is the page's *input*, never its state. Nothing the person does in the browser is
 * written back here, and nothing here is read from the browser's own storage — the
 * screens are rendered from what the server holds and from nowhere else (RULE-56).
 *
 * `today` is the server's date, carried so the browser marks the same ToDos overdue
 * as the server did: a clock read on each side would hydrate onto markup it disagrees
 * with at midnight.
 */
export type PageData =
  | {
    page: 'home'; defaultMinutes: number; items: HomeTodoItem[]; agents: HomeAgent[];
    defaultFrom: string; defaultTo: string; today: string;
  }
  | { page: 'timeline'; tasks: TimelineTask[] }
  | { page: 'agent-detail'; agentId: string; status: AgentStatusResponse; faultInjectionEnabled?: boolean; faultTrials?: FaultTrial[] }
  | { page: 'security'; runs: AnalysisRun[]; now: number }
  | { page: 'todo-new'; defaultMinutes: number }
  | { page: 'guide' };

/** Where the browser half looks for it. One id, named once. */
export const PAGE_DATA_ID = 'page-data';

/**
 * Where hydration attaches.
 *
 * It sits here rather than beside the shell that renders it because the browser needs
 * it and the shell imports React's server renderer: taking the id from there pulled
 * `react-dom/server` into the page's bundle, which is a few hundred kilobytes of code
 * for turning components into HTML — work that has already happened by the time the
 * browser has the page.
 */
export const ROOT_ID = 'root';

/**
 * The JSON, safe to sit inside a `<script>`.
 *
 * `<` is the only character that can end the element early, and escaping it as `<`
 * leaves the value identical to `JSON.parse`. Without this, an event whose message
 * happened to contain `</script>` would end the block and put the rest of a person's
 * timeline into the document as markup.
 */
export function serialisePageData(data: PageData): string {
  return JSON.stringify(data).replaceAll('<', '\\u003c');
}

/** The value the server wrote, or null on a page that carries none. */
export function readPageData(document_: Document): PageData | null {
  const element = document_.getElementById(PAGE_DATA_ID);
  const text = element?.textContent;
  if (!text) return null;
  return JSON.parse(text) as PageData;
}
