import { agentPagePath } from '../../agents/page-link.js';
import { JourneyStrip } from './journey-strip.js';
import { TaskRow, type TaskRowProps } from './task-row.js';
import type { Element } from '../element.js';

export const NO_AGENT_YET = 'Agent はまだ作られていません';

/**
 * Tasks belong to an agent; the grouping is the person's mental model, not ours.
 *
 * The heading is the work the agent was made for, and the line under it names the
 * agent — or says there is none yet, which is what a story that has reached the
 * decision but not the Provisioner looks like from here.
 *
 * Under the name, the same tasks twice: once as a line of stops, to see the shape of
 * the story at a glance, and once as rows, to read it. Both lists come from one array
 * in one order, so the line cannot show a stop the rows do not have.
 */
export function AgentGroup(props: {
  runId: string;
  agentId: string | null;
  purpose: string;
  tasks: readonly TaskRowProps[];
}): Element {
  return (
    <section className="agent-group" data-run-id={props.runId} data-agent-id={props.agentId ?? ''}>
      <div className="section-heading"><h2>{props.purpose}</h2>{props.agentId ? <a href={agentPagePath(props.agentId)}>実行状況 →</a> : null}</div>
      <p className="agent-group-meta">
        {props.agentId === null
          ? <span data-field="agent-missing">{NO_AGENT_YET}</span>
          : <span className="agent-group-id" data-field="agent-id">{props.agentId}</span>}
      </p>
      <JourneyStrip tasks={props.tasks} />
      <ol className="task-list">
        {props.tasks.map((task) => <TaskRow key={task.task_id} {...task} />)}
      </ol>
    </section>
  );
}
