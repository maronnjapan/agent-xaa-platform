import type { TimelineTask } from '../../activity/query.js';
import { Metric, ResultMark, formatTime, formatDuration, phaseLabel } from '../components/visual.js';
import { OutcomeBadge } from '../components/outcome-badge.js';
import { DetailDisclosure } from '../components/detail-disclosure.js';
import { AgentGroup } from '../components/agent-group.js';
import { ReplayCanvas } from '../components/replay-canvas.js';
import type { TaskRowProps } from '../components/task-row.js';
import type { Element } from '../element.js';

function isSimulated(task: TimelineTask): boolean {
  return task.status === 'completed' && task.events.some((event) => event.is_simulated === true);
}

function toRow(task: TimelineTask): TaskRowProps {
  if (task.status === 'running') {
    return {
      agent_id: task.agent_id,
      task_id: task.task_id,
      purpose: task.purpose,
      status: 'running',
      simulated: false,
    };
  }
  const terminal = task.events[task.events.length - 1];
  return {
    agent_id: task.agent_id,
    event_count: task.events.length,
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
      <header class="page-heading">
        <div>
          <span class="eyebrow">ACTIVITY</span>
          <h1>アクティビティ</h1>
          <p class="lead">何が実行され、どこで止まったかを確認できます。</p>
        </div>
        <button type="button" data-action="refresh">
          更新
        </button>
      </header>
      <div class="metric-grid">
        <Metric label="すべてのタスク" value={props.tasks.length} />
        <Metric
          label="実行中"
          value={props.tasks.filter((task) => task.status === 'running').length}
          tone="blue"
        />
        <Metric
          label="成功"
          value={
            props.tasks.filter((task) => task.status === 'completed' && task.terminal_outcome === 'success')
              .length
          }
          tone="green"
        />
        <Metric
          label="遮断"
          value={
            props.tasks.filter((task) => task.status === 'completed' && task.terminal_outcome === 'blocked').length
          }
          tone="amber"
        />
        <Metric
          label="失敗"
          value={
            props.tasks.filter((task) => task.status === 'completed' && task.terminal_outcome === 'failed').length
          }
          tone="red"
        />
      </div>
      <div class="timeline-toolbar">
        <label>
          表示する結果{' '}
          <select data-filter="outcome">
            <option value="all">すべて</option>
            <option value="running">実行中</option>
            <option value="success">成功</option>
            <option value="blocked">遮断</option>
            <option value="failed">失敗</option>
          </select>
        </label>
        <label class="activity-search">検索<input type="search" data-filter="search" placeholder="作業名・Agent・Task ID" /></label>
        <span class="muted">時刻は日本時間 · タスクを選ぶと経路とログを表示</span>
      </div>
      <p role="status" data-timeline-status="true" />
      {props.tasks.length === 0 ? (
        <div class="empty-state">
          <h2>アクティビティはまだありません</h2>
          <p>作業を定義してAgentを実行すると、ここに履歴が表示されます。</p>
          <a href="/work-definitions/new">新しい作業を定義する →</a>
        </div>
      ) : null}
      {[...groups].map(([agentId, tasks]) => (
        <AgentGroup
          agentId={agentId === '' ? null : agentId}
          purpose={tasks[0]?.purpose ?? ''}
          tasks={tasks.map(toRow)}
        />
      ))}
      {props.tasks
        .filter((task): task is Extract<TimelineTask, { status: 'completed' }> => task.status === 'completed')
        .map((task) => (
          <section
            class="card task-inspector"
            data-inspector-task={task.task_id}
            data-agent-id={task.agent_id ?? ''}
            hidden
          >
            <header class="section-heading">
              <div>
                <span class="eyebrow">TASK DETAIL</span>
                <h2>
                  {task.purpose} / {task.task_id}
                </h2>
              </div>
              <button type="button" data-action="play-replay">
                経路を再生
              </button>
            </header>
            <ReplayCanvas taskId={task.task_id} events={task.events} simulated={isSimulated(task)} />
            <div class="section-heading"><h3>イベントログ</h3><span class="muted">{task.events.length} イベント · 記録区間 {formatDuration(Date.parse(task.completed_at) - Date.parse(task.events[0]?.occurred_at ?? task.completed_at))}</span></div>
            <ol class="event-outline" aria-label="記録された処理の流れ">{task.events.map((event, index) => <li data-outcome={event.outcome}>
              <span>{String(index + 1).padStart(2, '0')}</span><ResultMark outcome={event.outcome} /><strong>{phaseLabel(event.phase)}</strong>
              <small>{event.source}</small><span class="sr-only">{event.outcome}</span>
            </li>)}</ol>
            <ol class="event-stream">
              {task.events.map((event, index) => (
                <li data-outcome={event.outcome}>
                  <ResultMark outcome={event.outcome} />
                  <div class="event-content">
                    <div class="section-heading">
                      <strong><small class="step-label">STEP {String(index + 1).padStart(2, '0')}</small>{event.message}</strong>
                      <OutcomeBadge outcome={event.outcome} phase={event.phase} />
                    </div>
                    <p class="muted">
                      <time datetime={event.occurred_at}>{formatTime(event.occurred_at)}</time> ·{' '}
                      {event.source} · {phaseLabel(event.phase)}
                    </p>
                    <DetailDisclosure
                      detail={event.detail as Record<string, unknown>}
                      simulated={event.is_simulated === true}
                    />
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
    </main>
  );
}
