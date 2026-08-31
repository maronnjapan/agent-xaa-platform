import type { TimelineTask } from '../../activity/query.js';
import { AgentGroup } from '../components/agent-group.js';
import { ReplayCanvas } from '../components/replay-canvas.js';
import type { TaskRowProps } from '../components/task-row.js';
import type { Element } from '../element.js';


function isSimulated(task: TimelineTask): boolean {
  return task.status === 'completed' && task.events.some((event) => event.is_simulated === true);
}

function toRow(task: TimelineTask): TaskRowProps {
  if (task.status === 'running') {
    return { task_id: task.task_id, purpose: task.purpose, status: 'running', simulated: false };
  }
  const terminal = task.events[task.events.length - 1];
  return {
    task_id: task.task_id,
    purpose: task.purpose,
    status: 'completed',
    terminal_outcome: task.terminal_outcome,
    completed_at: task.completed_at,
    ...(terminal ? { phase: terminal.phase } : {}),
    ...(terminal?.detail ? { detail: terminal.detail as Record<string, unknown> } : {}),
    simulated: isSimulated(task),
  };
}

/**
 * Tasks grouped by agent, newest agent first.
 *
 * Within a group the order is fixed: provisioning, then the numbered tasks in the
 * order they finished, then lifecycle — which is the order the work actually happened
 * in. `readTimeline` has already sorted them; this only groups.
 */
export function TimelinePage(props: { tasks: readonly TimelineTask[] }): Element {
  const groups = new Map<string, TimelineTask[]>();
  for (const task of props.tasks) {
    const key = task.agent_id ?? '';
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return (
    <main class="timeline" data-page="timeline">
      <button type="button" data-action="refresh">更新</button>
      {[...groups].map(([agentId, tasks]) => (
        <AgentGroup agentId={agentId === '' ? null : agentId} purpose={tasks[0]?.purpose ?? ''} tasks={tasks.map(toRow)} />
      ))}
      {props.tasks
        .filter((task): task is Extract<TimelineTask, { status: 'completed' }> => task.status === 'completed')
        .map((task) => (
          <ReplayCanvas taskId={task.task_id} events={task.events} simulated={isSimulated(task)} />
        ))}
    </main>
  );
}
