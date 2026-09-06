import { AgentDetailPage } from './pages/agent-detail.js';
import { GuidePage } from './pages/guide.js';
import { HomePage } from './pages/home.js';
import { SecurityPage } from './pages/security.js';
import { TimelinePage } from './pages/timeline.js';
import { WorkDefinitionNewPage } from './pages/work-definition-new.js';
import type { PageData } from './page-data.js';
import type { Element } from './element.js';

/**
 * The one place a page's name becomes a page.
 *
 * The server renders through here and so does the browser, from the same value, which
 * is the whole reason the two agree. A second switch — a browser entry point that
 * decided for itself which component a `data-page` meant — would be a second answer to
 * a question that must only have one, and it would be wrong on exactly the day someone
 * added a screen and updated one of the two.
 */
export function PageRoot(props: { data: PageData }): Element {
  const data = props.data;
  switch (data.page) {
    case 'home':
      return (
        <HomePage
          defaultMinutes={data.defaultMinutes}
          items={data.items}
          agents={data.agents}
          defaultFrom={data.defaultFrom}
          defaultTo={data.defaultTo}
        />
      );
    case 'timeline':
      return <TimelinePage tasks={data.tasks} />;
    case 'security':
      return <SecurityPage agents={data.agents} />;
    case 'agent-detail':
      return <AgentDetailPage agentId={data.agentId} status={data.status} />;
    case 'work-definition-new':
      return <WorkDefinitionNewPage defaultMinutes={data.defaultMinutes} />;
    case 'guide':
      return <GuidePage />;
  }
}
