import { ResultMark, formatTime } from './visual.js';
import { OutcomeBadge } from './outcome-badge.js';
import { DetailDisclosure } from './detail-disclosure.js';
import { SimulatedBadge } from './simulated-badge.js';
import type { Element } from '../element.js';


export interface TaskRowProps {
  task_id: string;
  agent_id?: string | null;
  event_count?: number;
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
 */
export function TaskRow(props: TaskRowProps): Element {
  const running = props.status === 'running';
  return (
    <li class="task-row">
      <button
        type="button"
        class={`task-button ${running ? 'is-running' : ''}`}
        data-task-button="true"
        data-task-id={props.task_id}
        data-agent-id={props.agent_id ?? ''}
        aria-expanded="false"
        data-outcome={props.terminal_outcome ?? ''}
        data-status={props.status}
        {...(running ? { disabled: true } : {})}
      >
        <ResultMark outcome={running ? 'running' : props.terminal_outcome ?? 'info'} />
        {props.simulated ? <SimulatedBadge position="row" /> : null}
        <span class="col-purpose">{props.purpose}</span>
<span class="col-task-id">{props.task_id}{props.event_count !== undefined ? ` · ${props.event_count} イベント` : ''}</span>
        <span class="col-outcome">
          {running ? '実行中' : <OutcomeBadge outcome={props.terminal_outcome ?? 'info'} phase={props.phase ?? 'tool_call'} />}
        </span>
        <span class="col-completed-at">{props.completed_at ? formatTime(props.completed_at) : '完了待ち'}</span>
      </button>
      <DetailDisclosure {...(props.detail ? { detail: props.detail } : {})} simulated={props.simulated === true} />
    </li>
  );
}
