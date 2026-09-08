import { agentPagePath } from '../../agents/page-link.js';
import { TaskRow, type TaskRowProps } from './task-row.js';
import type { Element } from '../element.js';

/** Tasks belong to an agent; the grouping is the person's mental model, not ours. */
export function AgentGroup(props: {
  agentId: string | null;
  purpose: string;
  tasks: readonly TaskRowProps[];
}): Element {
  return (
    <section class="agent-group" data-agent-id={props.agentId ?? ''}>
      <div class="section-heading">
        <div>
          <span class="eyebrow">{props.agentId ? 'AGENT' : 'USER ACTIVITY'}</span>
          <h2>{props.purpose || 'アクティビティ'}</h2>
          {/* The heading text is whatever the events called the work, which is not
              unique between agents. The id is, and it is the same string the agent's
              own page shows, so two groups can be told apart. */}
          {props.agentId ? <p class="muted agent-identifier">{props.agentId}</p> : null}
        </div>
        {props.agentId ? <a href={agentPagePath(props.agentId)}>実行状況 →</a> : null}
      </div>
      <ol class="task-list">
        {props.tasks.map((task) => (
          <TaskRow {...task} />
        ))}
      </ol>
    </section>
  );
}
