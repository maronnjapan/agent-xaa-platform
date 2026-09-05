import type { ActivityEvent } from '@xaa/contracts';
import type { TimelineTask } from '../../activity/query.js';
import { AgentGroup } from '../components/agent-group.js';
import { EventLog, type LogEvent } from '../components/event-log.js';
import { ReplayCanvas } from '../components/replay-canvas.js';
import type { TaskRowProps } from '../components/task-row.js';
import type { Element } from '../element.js';

export const TIMELINE_LEAD = '完了した処理を、図の再生と、起きたことの一覧の両方で残しています。どちらも同じ記録から作っています。';

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
 * An event as the log renders it: the same values, named rather than spread.
 *
 * The event arrives from the store and is on its way to a browser. Spreading it would
 * forward whatever the store or a future publisher happens to add — the same reason
 * the agent status endpoint copies field by field (RULE-38).
 */
function toLogEvent(event: ActivityEvent): LogEvent {
  return {
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    source: event.source,
    phase: event.phase,
    outcome: event.outcome,
    title: event.title,
    message: event.message,
    ...(event.detail ? { detail: event.detail as Record<string, unknown> } : {}),
    ...(event.record ? { record: event.record } : {}),
  };
}

/**
 * Tasks grouped by agent, newest agent first, and then one replay per finished task.
 *
 * Within a group the order is fixed: provisioning, then the numbered tasks in the
 * order they finished, then lifecycle — which is the order the work actually happened
 * in. `readTimeline` has already sorted them; this only groups.
 *
 * Each finished task gets both a picture and a written account, from the same events.
 * They are not alternatives: the picture answers "what talked to what, and where did
 * it stop", and the account answers "what was sent, what came back, and what was
 * checked first". Either alone leaves the other question unanswered.
 */
export function TimelinePage(props: { tasks: readonly TimelineTask[] }): Element {
  const groups = new Map<string, TimelineTask[]>();
  for (const task of props.tasks) {
    const key = task.agent_id ?? '';
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const completed = props.tasks
    .filter((task): task is Extract<TimelineTask, { status: 'completed' }> => task.status === 'completed');
  return (
    <main class="timeline" data-page="timeline">
      <p class="lead">{TIMELINE_LEAD}</p>
      <button type="button" data-action="refresh">更新</button>
      {[...groups].map(([agentId, tasks]) => (
        <AgentGroup agentId={agentId === '' ? null : agentId} purpose={tasks[0]?.purpose ?? ''} tasks={tasks.map(toRow)} />
      ))}
      {completed.map((task) => (
        <section class="task-replay" data-replay-for={task.task_id}>
          <h2>{task.purpose}</h2>
          <p class="task-replay-meta">
            <span class="col-task-id">{task.task_id}</span>
            <time datetime={task.completed_at}>{task.completed_at}</time>
          </p>
          <ReplayCanvas taskId={task.task_id} events={task.events} simulated={isSimulated(task)} />
          <EventLog taskId={task.task_id} events={task.events.map(toLogEvent)} />
        </section>
      ))}
    </main>
  );
}
