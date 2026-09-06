import { useCallback, useState } from 'react';
import type { ActivityEvent } from '@xaa/contracts';
import type { TimelineTask } from '../../activity/query.js';
import { taskKeyOf } from '../../activity/task-key.js';
import { AgentGroup } from '../components/agent-group.js';
import { CastPanel } from '../components/cast-panel.js';
import { partiesIn } from '../roles.js';
import type { LogEvent } from '../components/event-log.js';
import { LocalTime } from '../components/local-time.js';
import { TaskReplay } from '../components/task-replay.js';
import type { TaskRowProps } from '../components/task-row.js';
import type { Element } from '../element.js';

export const TIMELINE_LEAD = '完了した処理を、図の再生と、起きたことの一覧の両方で残しています。どちらも同じ記録から作っています。Agent ごとにまとめ、新しい Agent を上に置いています。';
export const TIMELINE_CAST_LEAD = '出てくる箱が何をするところかは、次の一覧にまとめてあります。';
export const TIMELINE_EMPTY = 'まだ記録がありません。作業を書いて Agent を作ると、ここに並びます。';

function isSimulated(task: TimelineTask): boolean {
  return task.status === 'completed' && task.events.some((event) => event.is_simulated === true);
}

function toRow(task: TimelineTask): TaskRowProps {
  if (task.status === 'running') {
    return { run_id: task.run_id, task_id: task.task_id, purpose: task.purpose, status: 'running', simulated: false };
  }
  const terminal = task.events[task.events.length - 1];
  return {
    run_id: task.run_id,
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
 * A group is one agent's whole story — from the login that preceded it, through the
 * proposal and the decision, to its tasks and its end — and the grouping is by
 * `run_id`, which `readTimeline` has already resolved. Within a group the order is
 * fixed: provisioning, then the numbered tasks in the order they finished, then
 * lifecycle, which is the order the work actually happened in. This only groups.
 *
 * Each finished task gets a picture, the agent's reasoning beside it, and a written
 * account below. They are not alternatives: the picture answers "what talked to what,
 * and where did it stop", the reasoning answers "why did it do that", and the account
 * answers "what was sent, what came back, and what was checked first". Any one of them
 * alone leaves the other two questions unanswered.
 *
 * The list of what each box is opens the page rather than hiding at the bottom of it,
 * because the names in every row below are meaningless until someone has read it once.
 *
 * Refreshing is a button. The page asks once when it opens and once per press, and at
 * no other time: a timeline that streamed would need a live channel to the datastore,
 * and the browser is deliberately never given one (DEV-13).
 */
export function TimelinePage(props: { tasks: readonly TimelineTask[] }): Element {
  const [tasks, setTasks] = useState<readonly TimelineTask[]>(props.tasks);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
        if (!response.ok) return;
        const body = await response.json() as { tasks: TimelineTask[] };
        setTasks(body.tasks);
      } finally {
        setRefreshing(false);
      }
    })();
  }, []);

  const groups = new Map<string, TimelineTask[]>();
  for (const task of tasks) {
    groups.set(task.run_id, [...(groups.get(task.run_id) ?? []), task]);
  }
  const sources = partiesIn(tasks.flatMap((task) => (task.status === 'completed' ? task.events : [])));

  return (
    <main className="timeline" data-page="timeline">
      <p className="lead">{TIMELINE_LEAD}</p>
      <p className="lead">{TIMELINE_CAST_LEAD}</p>
      <CastPanel sources={sources} open />
      <button type="button" data-action="refresh" onClick={refresh} disabled={refreshing}>更新</button>
      {tasks.length === 0 ? <p className="timeline-empty" data-field="timeline-empty">{TIMELINE_EMPTY}</p> : null}
      {[...groups].map(([runId, runTasks]) => (
        <section key={runId} className="run" data-run={runId}>
          <AgentGroup
            runId={runId}
            agentId={runTasks[0]?.agent_id ?? null}
            purpose={runTasks[0]?.purpose ?? ''}
            tasks={runTasks.map(toRow)}
          />
          {runTasks
            .filter((task): task is Extract<TimelineTask, { status: 'completed' }> => task.status === 'completed')
            .map((task) => (
              <section key={taskKeyOf(task)} className="task-replay" data-replay-for={taskKeyOf(task)} data-task-id={task.task_id}>
                <h3>
                  <span className="col-task-id">{task.task_id}</span>
                  <span className="task-replay-purpose">{task.purpose}</span>
                </h3>
                <p className="task-replay-meta">
                  <LocalTime at={task.completed_at} />
                  <span className="task-replay-count">{`${task.events.length} 件`}</span>
                </p>
                <TaskReplay
                  taskId={task.task_id}
                  taskKey={taskKeyOf(task)}
                  events={task.events}
                  logEvents={task.events.map(toLogEvent)}
                  simulated={isSimulated(task)}
                />
              </section>
            ))}
        </section>
      ))}
    </main>
  );
}
