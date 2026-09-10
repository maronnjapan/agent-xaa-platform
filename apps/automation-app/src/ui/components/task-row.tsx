import type { TimelineTask } from '../../activity/query.js';
import { taskKeyOf } from '../../activity/task-key.js';
import { activityFocusPath } from '../activity-links.js';
import { durationBetween, taskLabelOf } from '../labels.js';
import { emphasisClass } from '../replay/emphasis.js';
import { LocalTime } from './local-time.js';
import { OutcomeBadge } from './outcome-badge.js';
import { SimulatedBadge } from './simulated-badge.js';
import { TaskShape } from './task-shape.js';
import type { Element } from '../element.js';

export const TASK_RUNNING_LABEL = '実行中';
export const TASK_RUNNING_NOTE = '途中経過は Agent の画面の「実行ログ」で確認できます。';
export const TASK_REPLAY_LABEL = 'アニメーションで見る';
export const TASK_LOG_LABEL = 'ログを読む';

type CompletedTask = Extract<TimelineTask, { status: 'completed' }>;

/** The publisher's own word count: how many of this task's events were refusals. */
export function blockedCountOf(task: TimelineTask): number {
  return task.status === 'completed' ? task.events.filter((event) => event.outcome === 'blocked').length : 0;
}

/** How many of this task's events say something failed, the task's own end included. */
export function failedCountOf(task: TimelineTask): number {
  if (task.status !== 'completed') return 0;
  const failed = task.events.filter((event) => event.outcome === 'failed').length;
  // An older `TASK_FAILED` was recorded as `info`; the reader already names the task's
  // end `failed` for it, and the count says so once rather than not at all.
  return failed > 0 || task.terminal_outcome !== 'failed' ? failed : 1;
}

/** Refusals and failures together: the rows a person switching to 「問題があったものだけ」 wants. */
export function issueCountOf(task: TimelineTask): number {
  return blockedCountOf(task) + failedCountOf(task);
}

export function isSimulated(task: TimelineTask): boolean {
  return task.status === 'completed' && task.events.some((event) => event.is_simulated === true);
}

/**
 * One task of an agent, as one line on the rail: what kind of step it was, how it
 * ended, when, how much happened in it — and two doors into the viewer.
 *
 * The line is what a person scans. It says 準備 / 作業 1 / 終了 rather than
 * `provisioning` / `task-1` / `lifecycle`, gives the publisher's own last word on the
 * task as its title (「作業が完了しました」, 「Agent を停止しました」), draws one dot per
 * event in the colour of how it ended, and counts the events and the refusals and
 * failures among them. The counts are counts of the publishers' own `outcome`;
 * nothing here decides what a task amounted to (RULE-54).
 *
 * It opens into nothing. The picture of the task and its written account are each a
 * screen of their own in the viewer, reached by the two links at the end of the line,
 * because a list in which every task unfolded into a picture and a log was a page a
 * person could not follow with their eyes. The links are addresses, so a person
 * without script follows them too.
 *
 * A running task has a line and no doors. There is nothing complete to show yet, and a
 * partial replay would be a story that has not happened (RULE-59). The line still says
 * the task exists, because hiding it would leave a person wondering where their work
 * went.
 *
 * `data-task-key` is what the page and the tests use to find this row: two agents both
 * have a `task-1`, so the id alone names two things on one page.
 */
export function TaskRow(props: {
  task: TimelineTask;
  /** The agent the list is narrowed to, carried into the viewer's addresses so closing it comes back here. */
  narrowedTo?: string | null;
}): Element {
  const task = props.task;
  const key = taskKeyOf(task);
  const kind = taskLabelOf(task.task_id);
  if (task.status === 'running') {
    return (
      <li
        className="stage"
        data-stage={key}
        data-task-key={key}
        data-task-id={task.task_id}
        data-task-kind={kind.kind}
        data-status="running"
        data-issue-count="0"
      >
        <span className="stage-marker" aria-hidden="true" />
        <div className="stage-card is-running">
          <p className="stage-head">
            <span className="stage-kind">{kind.label}</span>
            <span className="stage-title" data-field="stage-title">{TASK_RUNNING_NOTE}</span>
            <span className="badge ev-running" data-field="stage-status">{TASK_RUNNING_LABEL}</span>
          </p>
        </div>
      </li>
    );
  }
  return <CompletedRow task={task} taskKey={key} narrowedTo={props.narrowedTo ?? null} />;
}

function CompletedRow(props: { task: CompletedTask; taskKey: string; narrowedTo: string | null }): Element {
  const { task, taskKey } = props;
  const kind = taskLabelOf(task.task_id);
  const first = task.events[0];
  const terminal = task.events[task.events.length - 1];
  const blocked = blockedCountOf(task);
  const failed = failedCountOf(task);
  const simulated = isSimulated(task);
  const phase = terminal?.phase ?? 'tool_call';
  const took = first ? durationBetween(first.occurred_at, task.completed_at) : '';
  const door = (view: 'replay' | 'log'): string =>
    activityFocusPath({ runId: task.run_id, taskId: task.task_id, view, eventId: null }, props.narrowedTo);
  return (
    <li
      className="stage"
      data-stage={taskKey}
      data-task-key={taskKey}
      data-task-id={task.task_id}
      data-task-kind={kind.kind}
      data-status="completed"
      data-outcome={task.terminal_outcome}
      data-emphasis={emphasisClass(task.terminal_outcome, phase)}
      data-issue-count={String(blocked + failed)}
      {...(simulated ? { 'data-simulated': 'true' } : {})}
    >
      <span className="stage-marker" aria-hidden="true" />
      <div className="stage-card" data-stage-card={taskKey}>
        <p className="stage-head">
          <span className="stage-kind">{kind.label}</span>
          <span className="stage-title" data-field="stage-title">{terminal?.title ?? ''}</span>
          {simulated ? <SimulatedBadge position="row" /> : null}
          <OutcomeBadge outcome={task.terminal_outcome} phase={phase} />
        </p>
        <p className="stage-meta">
          <TaskShape shape={task.events.map((event) => ({ phase: event.phase, outcome: event.outcome }))} />
          <LocalTime className="stage-when" at={task.completed_at} format="short" />
          {took === '' ? null : <span className="stage-took" data-field="stage-took">{`所要 ${took}`}</span>}
          <span className="stage-count" data-field="stage-count">{`${task.events.length} 件のできごと`}</span>
          {blocked > 0 ? <span className="stage-blocked" data-field="stage-blocked">{`遮断 ${blocked} 件`}</span> : null}
          {failed > 0 ? <span className="stage-failed" data-field="stage-failed">{`失敗 ${failed} 件`}</span> : null}
          <span className="stage-actions">
            <a href={door('replay')} data-action="task-replay">{TASK_REPLAY_LABEL}</a>
            <a href={door('log')} data-action="task-log">{TASK_LOG_LABEL}</a>
          </span>
        </p>
      </div>
    </li>
  );
}
