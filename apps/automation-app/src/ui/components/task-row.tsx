import { PhaseIcon } from './phase-icon.js';
import { ResultMark, formatDuration, formatTime, phaseLabel } from './visual.js';
import { OutcomeBadge } from './outcome-badge.js';
import { DetailDisclosure } from './detail-disclosure.js';
import { SimulatedBadge } from './simulated-badge.js';
import type { Element } from '../element.js';

export interface TaskRowProps {
  run_id?: string;
  task_id: string;
  purpose: string;
  status: 'running' | 'completed';
  terminal_outcome?: string;
  completed_at?: string;
  phase?: string;
  detail?: Record<string, unknown>;
  simulated?: boolean;
  /** How many events the task recorded, for the strip beside the row. */
  event_count?: number;
  /** From the first recorded event to the last, in milliseconds. */
  duration_ms?: number;
  /** The events in order, reduced to the two values the strip draws a dot from. */
  shape?: ReadonlyArray<{ phase: string; outcome: string }>;
}

/** More dots than this and the strip says how many are left rather than drawing them. */
const SHAPE_LIMIT = 24;

/**
 * One row per task: purpose, which task it was, how it ended, and when.
 *
 * A running task is a disabled button with no handler. It is rendered — hiding it
 * would leave a person wondering where their work went — but it cannot be opened,
 * because there is nothing complete to replay yet (RULE-59).
 *
 * `data-task-key` is what the browser uses to find this row's replay: two agents both
 * have a `task-1`, so the id alone names two things on one page.
 *
 * The strip of dots under the outcome is the task's shape: one dot per event, in
 * order, coloured by how it ended. Twelve green dots and one amber one say where a
 * task was stopped before the row is read; the words in the badge still say it too.
 */
export function TaskRow(props: TaskRowProps): Element {
  const running = props.status === 'running';
  const key = props.run_id ? `${props.run_id}:${props.task_id}` : props.task_id;
  const phase = props.phase ?? (props.task_id === 'provisioning' ? 'provisioning' : props.task_id === 'lifecycle' ? 'lifecycle' : 'tool_call');
  return (
    <li className="task-row">
      <button
        type="button"
        className={`task-button ${running ? 'is-running' : ''}`}
        data-task-button="true"
        data-task-id={props.task_id}
        data-task-key={key}
        data-outcome={props.terminal_outcome ?? ''}
        data-status={props.status}
        {...(running ? { disabled: true } : {})}
        onClick={() => Array.from(document.querySelectorAll<HTMLElement>('[data-replay-for]')).find((panel) => panel.dataset.replayFor === key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      >
        <ResultMark outcome={running ? 'running' : props.terminal_outcome ?? 'info'} />
        {props.simulated ? <SimulatedBadge position="row" /> : null}
        <span className="col-purpose"><PhaseIcon phase={phase} className="row-phase" />{props.purpose}</span>
        <span className="col-task-id">{props.task_id}</span>
        <span className="col-outcome">
          {running ? '実行中' : <OutcomeBadge outcome={props.terminal_outcome ?? 'info'} phase={props.phase ?? 'tool_call'} />}
        </span>
        <span className="col-completed-at">
          {props.completed_at ? <time dateTime={props.completed_at}>{formatTime(props.completed_at)}</time> : ''}
        </span>
        {props.shape && props.shape.length > 0
          ? (
            <span className="col-shape">
              <TaskShape shape={props.shape} />
              <span className="col-duration">
                {props.event_count !== undefined ? `${props.event_count} 件` : ''}
                {props.duration_ms !== undefined && props.duration_ms > 0 ? ` · ${formatDuration(props.duration_ms)}` : ''}
              </span>
            </span>
          )
          : null}
      </button>
      <DetailDisclosure {...(props.detail ? { detail: props.detail } : {})} simulated={props.simulated === true} />
    </li>
  );
}

/** The dots. Each carries its phase and outcome as text for anyone who cannot see it. */
export function TaskShape(props: { shape: ReadonlyArray<{ phase: string; outcome: string }> }): Element {
  const shown = props.shape.slice(0, SHAPE_LIMIT);
  const rest = props.shape.length - shown.length;
  return (
    <span className="task-shape" data-task-shape="true" role="img" aria-label={`${props.shape.length} 件の記録`}>
      {shown.map((dot, index) => (
        <span key={index} className="shape-dot" data-outcome={dot.outcome} data-phase={dot.phase} title={`${index + 1}. ${phaseLabel(dot.phase)} · ${dot.outcome}`} />
      ))}
      {rest > 0 ? <span className="shape-more">+{rest}</span> : null}
    </span>
  );
}
