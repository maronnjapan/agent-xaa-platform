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
}

/**
 * One row per task: purpose, which task it was, how it ended, and when.
 *
 * A running task is a disabled button with no handler. It is rendered — hiding it
 * would leave a person wondering where their work went — but it cannot be opened,
 * because there is nothing complete to replay yet (RULE-59).
 *
 * `data-task-key` is what the browser uses to find this row's replay: two agents both
 * have a `task-1`, so the id alone names two things on one page.
 */
export function TaskRow(props: TaskRowProps): Element {
  const running = props.status === 'running';
  const key = props.run_id ? `${props.run_id}:${props.task_id}` : props.task_id;
  return (
    <li class="task-row">
      <button
        type="button"
        class={`task-button ${running ? 'is-running' : ''}`}
        data-task-id={props.task_id}
        data-task-key={key}
        data-outcome={props.terminal_outcome ?? ''}
        data-status={props.status}
        {...(running ? { disabled: true } : {})}
      >
        {props.simulated ? <SimulatedBadge position="row" /> : null}
        <span class="col-purpose">{props.purpose}</span>
        <span class="col-task-id">{props.task_id}</span>
        <span class="col-outcome">
          {running ? '実行中' : <OutcomeBadge outcome={props.terminal_outcome ?? 'info'} phase={props.phase ?? 'tool_call'} />}
        </span>
        <span class="col-completed-at">
          {props.completed_at ? <time datetime={props.completed_at}>{props.completed_at}</time> : ''}
        </span>
      </button>
      <DetailDisclosure {...(props.detail ? { detail: props.detail } : {})} simulated={props.simulated === true} />
    </li>
  );
}
