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
      <h2>{props.purpose}</h2>
      <ol class="task-list">
        {props.tasks.map((task) => <TaskRow {...task} />)}
      </ol>
    </section>
  );
}
