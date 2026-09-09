import { useState } from 'react';
import type { ActivityEvent } from '@xaa/contracts';
import type { TimelineTask } from '../../activity/query.js';
import { taskKeyOf } from '../../activity/task-key.js';
import { durationBetween, taskLabelOf } from '../labels.js';
import { emphasisClass } from '../replay/emphasis.js';
import { EventLog, type LogEvent } from './event-log.js';
import { LocalTime } from './local-time.js';
import { OutcomeBadge } from './outcome-badge.js';
import { SimulatedBadge } from './simulated-badge.js';
import { TaskStage } from './task-replay.js';
import type { Element } from '../element.js';

export const STAGE_RUNNING_LABEL = '実行中';
export const STAGE_RUNNING_NOTE = '終わると、ここに中身が出ます。途中経過は Agent の画面の「実行ログ」で読めます。';
export const STAGE_PLAYER_CAPTION = '動きを図で見る';
export const STAGE_PLAYER_NOTE = '「再生」で1手ずつ進みます。「一時停止」で止まり、「次へ」で自分で進められます。左の一覧では、いま説明している行が強調されます。';
export const STAGE_LOG_CAPTION = 'できごと';

type CompletedTask = Extract<TimelineTask, { status: 'completed' }>;

/** The publisher's own word count: how many of this task's events were refusals. */
export function blockedCountOf(task: TimelineTask): number {
  return task.status === 'completed' ? task.events.filter((event) => event.outcome === 'blocked').length : 0;
}

export function isSimulated(task: TimelineTask): boolean {
  return task.status === 'completed' && task.events.some((event) => event.is_simulated === true);
}

/**
 * An event as the log renders it: the same values, named rather than spread.
 *
 * The event arrives from the store and is on its way to a browser. Spreading it would
 * forward whatever the store or a future publisher happens to add — the same reason
 * the agent status endpoint copies field by field (RULE-38).
 */
export function toLogEvent(event: ActivityEvent): LogEvent {
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
    simulated: event.is_simulated === true,
  };
}

/**
 * One task of an agent, as one card on the rail: what kind of step it was, how it
 * ended, when, and — opened — everything that happened in it.
 *
 * The head is what a person scans. It says 準備 / 作業 1 / 終了 rather than
 * `provisioning` / `task-1` / `lifecycle`, gives the publisher's own last word on the
 * task as its title (「作業が完了しました」, 「Agent を停止しました」), and counts the
 * events and the refusals among them. The counts are counts of the publishers' own
 * `outcome`; nothing here decides what a task amounted to (RULE-54).
 *
 * The body is two things side by side, which are one step's two halves: the list of
 * what happened, in words, and the picture of it moving. The picture is a player the
 * person starts; the list is always there. They share one state — the event the
 * picture is on — so the row the picture explains is the row that is lit.
 *
 * A running task has a head and no body. There is nothing complete to show yet, and a
 * partial replay would be a story that has not happened (RULE-59). The head still
 * says the task exists, because hiding it would leave a person wondering where their
 * work went.
 *
 * `data-task-key` is what the page and the tests use to find this card: two agents both
 * have a `task-1`, so the id alone names two things on one page.
 */
export function StageCard(props: { task: TimelineTask; open?: boolean }): Element {
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
        data-blocked-count="0"
      >
        <span className="stage-marker" aria-hidden="true" />
        <div className="stage-card is-running">
          <p className="stage-head">
            <span className="stage-kind">{kind.label}</span>
            <span className="stage-title" data-field="stage-title">{kind.note}</span>
            <span className="badge ev-running" data-field="stage-status">{STAGE_RUNNING_LABEL}</span>
          </p>
          <p className="stage-note" data-field="stage-running-note">{STAGE_RUNNING_NOTE}</p>
        </div>
      </li>
    );
  }
  return <CompletedStage task={task} taskKey={key} open={props.open === true} />;
}

function CompletedStage(props: { task: CompletedTask; taskKey: string; open: boolean }): Element {
  const { task, taskKey } = props;
  const kind = taskLabelOf(task.task_id);
  const [current, setCurrent] = useState<string | null>(null);
  const first = task.events[0];
  const terminal = task.events[task.events.length - 1];
  const blocked = blockedCountOf(task);
  const simulated = isSimulated(task);
  const phase = terminal?.phase ?? 'tool_call';
  const took = first ? durationBetween(first.occurred_at, task.completed_at) : '';
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
      data-blocked-count={String(blocked)}
      {...(simulated ? { 'data-simulated': 'true' } : {})}
    >
      <span className="stage-marker" aria-hidden="true" />
      <details className="stage-card" data-stage-card={taskKey} open={props.open}>
        <summary className="stage-head">
          <span className="stage-kind">{kind.label}</span>
          <span className="stage-title" data-field="stage-title">{terminal?.title ?? ''}</span>
          {simulated ? <SimulatedBadge position="row" /> : null}
          <OutcomeBadge outcome={task.terminal_outcome} phase={phase} />
          <span className="stage-meta">
            <LocalTime className="stage-when" at={task.completed_at} format="short" />
            {took === '' ? null : <span className="stage-took" data-field="stage-took">{`所要 ${took}`}</span>}
            <span className="stage-count" data-field="stage-count">{`${task.events.length} 件のできごと`}</span>
            {blocked > 0 ? <span className="stage-blocked" data-field="stage-blocked">{`遮断 ${blocked} 件`}</span> : null}
          </span>
        </summary>
        <div className="stage-body">
          <div className="stage-log">
            <h4 className="stage-section-caption">{STAGE_LOG_CAPTION}</h4>
            <EventLog taskId={task.task_id} taskKey={taskKey} events={task.events.map(toLogEvent)} currentEventId={current} />
          </div>
          <aside className="stage-player" data-stage-player={taskKey}>
            <h4 className="stage-section-caption">{STAGE_PLAYER_CAPTION}</h4>
            <p className="stage-player-note">{STAGE_PLAYER_NOTE}</p>
            <TaskStage
              taskId={task.task_id}
              taskKey={taskKey}
              events={task.events}
              simulated={simulated}
              onCurrentEvent={setCurrent}
            />
          </aside>
        </div>
      </details>
    </li>
  );
}
