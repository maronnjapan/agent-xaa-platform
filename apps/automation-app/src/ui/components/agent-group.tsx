import { TaskRow, type TaskRowProps } from './task-row.js';
import type { Element } from '../element.js';

export const NO_AGENT_YET = 'Agent はまだ作られていません';

/**
 * Tasks belong to an agent; the grouping is the person's mental model, not ours.
 *
 * The heading is the work the agent was made for, and the line under it names the
 * agent — or says there is none yet, which is what a story that has reached the
 * decision but not the Provisioner looks like from here.
 */
export function AgentGroup(props: {
  runId: string;
  agentId: string | null;
  purpose: string;
  tasks: readonly TaskRowProps[];
}): Element {
  return (
    <section class="agent-group" data-run-id={props.runId} data-agent-id={props.agentId ?? ''}>
      <h2>{props.purpose}</h2>
      <p class="agent-group-meta">
        {props.agentId === null
          ? <span data-field="agent-missing">{NO_AGENT_YET}</span>
          : <span class="agent-group-id" data-field="agent-id">{props.agentId}</span>}
      </p>
      <ol class="task-list">
        {props.tasks.map((task) => <TaskRow {...task} />)}
      </ol>
    </section>
  );
}
