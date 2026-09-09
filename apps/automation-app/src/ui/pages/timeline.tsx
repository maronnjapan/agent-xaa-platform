import { Metric } from '../components/visual.js';
import { useCallback, useState } from 'react';
import type { ActivityEvent } from '@xaa/contracts';
import type { TimelineTask } from '../../activity/query.js';
import { taskKeyOf } from '../../activity/task-key.js';
import { AgentGroup } from '../components/agent-group.js';
import { CastPanel } from '../components/cast-panel.js';
import { partiesIn } from '../roles.js';
import type { LogEvent } from '../components/event-log.js';
import { RunReplay, type ReplayTask } from '../components/run-replay.js';
import type { TaskRowProps } from '../components/task-row.js';
import type { Element } from '../element.js';

export const TIMELINE_LEAD = '終わった処理を Agent ごとに、新しい順で並べています。まず動きを再生し、そのあと「やったこと」で中身を読みます。';
export const TIMELINE_CAST_LEAD = '箱の名前が分からないときは、次の一覧を開いてください。';
export const TIMELINE_EMPTY = 'まだ記録がありません。作業を書いて Agent を作ると、ここに並びます。';

type CompletedTask = Extract<TimelineTask, { status: 'completed' }>;

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

/** The same task, in the two shapes the pictures and the accounts each need. */
function toReplayTask(task: CompletedTask): ReplayTask {
  return {
    taskId: task.task_id,
    taskKey: taskKeyOf(task),
    purpose: task.purpose,
    completedAt: task.completed_at,
    events: task.events,
    logEvents: task.events.map(toLogEvent),
    simulated: isSimulated(task),
  };
}

/**
 * Tasks grouped by agent, newest agent first, and within an agent: the rows, then every
 * picture, then every account.
 *
 * A group is one agent's whole story — from the login that preceded it, through the
 * proposal and the decision, to its tasks and its end — and the grouping is by
 * `run_id`, which `readTimeline` has already resolved. Within a group the order is
 * fixed: provisioning, then the numbered tasks in the order they finished, then
 * lifecycle, which is the order the work actually happened in. This only groups.
 *
 * The picture and the account are not alternatives: the picture answers "what talked to
 * what, and where did it stop", and the account answers "what was sent, what came back,
 * and what was checked first". They are no longer interleaved task by task, because an
 * account runs to a hundred lines and put every pair of pictures a screenful apart
 * (`RunReplay`).
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
  const [outcome, setOutcome] = useState('all');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { tasks: TimelineTask[] };
        const agentFilter = new URLSearchParams(window.location.search).get('agent_id');
        setTasks(agentFilter ? body.tasks.filter((task) => task.agent_id === agentFilter) : body.tasks);
        setMessage('最新の記録を取得しました。');
      } catch {
        setMessage('更新できませんでした。表示は前回の取得結果です。');
      } finally {
        setRefreshing(false);
      }
    })();
  }, []);

  const shown = tasks.filter((task) => (outcome === 'all' || (task.status === 'running' ? 'running' : task.terminal_outcome) === outcome)
    && `${task.purpose} ${task.agent_id ?? ''} ${task.task_id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const groups = new Map<string, TimelineTask[]>();
  for (const task of shown) {
    groups.set(task.run_id, [...(groups.get(task.run_id) ?? []), task]);
  }
  const sources = partiesIn(tasks.flatMap((task) => (task.status === 'completed' ? task.events : [])));

  return (
    <main className="timeline" data-page="timeline">
      <header className="page-heading"><div><span className="eyebrow">ACTIVITY</span><h1>アクティビティ</h1><p className="lead">{TIMELINE_LEAD}</p></div>
        <button type="button" data-action="refresh" onClick={refresh} disabled={refreshing}>更新</button></header>
      <div className="metric-grid">
        <Metric label="すべてのタスク" value={tasks.length} />
        <Metric label="実行中" value={tasks.filter((task) => task.status === 'running').length} tone="blue" />
        <Metric label="成功" value={tasks.filter((task) => task.status === 'completed' && task.terminal_outcome === 'success').length} tone="green" />
        <Metric label="遮断" value={tasks.filter((task) => task.status === 'completed' && task.terminal_outcome === 'blocked').length} tone="amber" />
        <Metric label="失敗" value={tasks.filter((task) => task.status === 'completed' && task.terminal_outcome === 'failed').length} tone="red" />
      </div>
      <div className="timeline-toolbar">
        <label>表示する結果 <select data-filter="outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
          <option value="all">すべて</option><option value="running">実行中</option><option value="success">成功</option><option value="blocked">遮断</option><option value="failed">失敗</option>
        </select></label>
        <label className="activity-search">検索<input type="search" data-filter="search" placeholder="作業名・Agent・Task ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <span role="status">{shown.length} 件を表示</span>
      </div>
      <p role="status" data-timeline-status="true">{message}</p>
      <p className="lead">{TIMELINE_CAST_LEAD}</p>
      <CastPanel sources={sources} open />
      {tasks.length === 0 ? <p className="timeline-empty" data-field="timeline-empty">{TIMELINE_EMPTY}</p> : null}
      {tasks.length > 0 && shown.length === 0 ? <p className="empty-state">条件に一致するタスクはありません。</p> : null}
      {[...groups].map(([runId, runTasks]) => (
        <section key={runId} className="run" data-run={runId}>
          <AgentGroup
            runId={runId}
            agentId={runTasks[0]?.agent_id ?? null}
            purpose={runTasks[0]?.purpose ?? ''}
            tasks={runTasks.map(toRow)}
          />
          <RunReplay
            runId={runId}
            tasks={runTasks
              .filter((task): task is CompletedTask => task.status === 'completed')
              .map(toReplayTask)}
          />
        </section>
      ))}
    </main>
  );
}
