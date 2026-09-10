import type { FaultTrial } from '../../agents/faults.js';
import type { ExecutionFailure } from '@xaa/contracts';
import type { AgentStatusResponse } from '../../agents/status.js';
import { agentStatusLabelOf, formatRemaining, taskLabelOf, toolOutcomeLabelOf } from '../labels.js';
import { emphasisClass } from '../replay/emphasis.js';
import { OutcomeBar } from './outcome-bar.js';
import { ResultMark, formatTime } from './visual.js';
import { FAULT_KIND_TEXT, TrialTracker } from './trial-tracker.js';
import type { Element } from '../element.js';

export const STATUS_HEADING = '状況確認';
export const TOOLS_HEADING = '使ったツール';
export const TOOLS_EMPTY = 'まだツールを使っていません。';
export const FAULTS_HEADING = '異常系試験の状態';
export const FAILURE_LEAD = '直近の実行は失敗しました。';

/** What each named failure means, in the words the exercise promised. */
const FAILURE_TEXT: Readonly<Record<ExecutionFailure, string>> = {
  injected_runtime_crash: '異常系試験の要求により、Runtime が例外を投げて実行を中断しました。',
  injected_model_unavailable: '異常系試験の要求により、モデルを呼ばずに応答なしとして打ち切りました。',
};

/** What each state of a request says, in the row's own words. */
function trialText(trial: FaultTrial): string {
  switch (trial.state) {
    case 'queued': return '適用待ち';
    case 'received': return 'Runtime が受信済み';
    case 'failed': return FAULT_KIND_TEXT[trial.kind].confirmed;
    case 'not_applied': return '対象の作業が実行中ではないため未適用';
  }
}

/**
 * The agent as it is right now: one read, no history.
 *
 * This panel and the timeline answer different questions and must not be confused —
 * this one is a snapshot that includes work still in flight; the timeline replays only
 * what has finished. It reads the status endpoint and nothing else, so there is no way
 * for a partial event stream to leak into it.
 *
 * The values are printed in words — 稼働中 rather than `ACTIVE`, 58 分 rather than
 * `3480`, 作業 1 rather than `task-1` — with the code kept on the element for anyone
 * matching the screen against a log. The words name the value; they do not judge it.
 *
 * A failed execution is said apart from the agent's state, because they are different
 * things: the state is the Lifecycle's nine values (docs 07 §2), and an execution that
 * failed leaves it `ACTIVE`. The failure exercises a person asked for are listed with
 * how far each has got, so 「まだ」 and 「もう起きない」 are not the same picture.
 */
export function StatusPanel(props: { status: AgentStatusResponse; faultTrials?: FaultTrial[] }): Element {
  const status = props.status;
  const calls = status.tool_invocations;
  const failure = status.execution_failure;
  const counts = {
    success: calls.filter((call) => call.outcome === 'success').length,
    blocked: calls.filter((call) => call.outcome === 'blocked').length,
    failed: calls.filter((call) => call.outcome === 'failed').length,
  };
  return (
    <section data-section="status" className="status-panel">
      <h2>{STATUS_HEADING}</h2>
      <dl className="status-grid">
        <div>
          <dt>状態</dt>
          <dd data-field="agent_status" data-value={status.agent_status}>
            <span className="status-pill" data-agent-status={status.agent_status}>{agentStatusLabelOf(status.agent_status)}</span>
            <code className="status-code">{status.agent_status}</code>
          </dd>
        </div>
        <div>
          <dt>残り時間</dt>
          <dd data-field="remaining_seconds" data-value={String(status.remaining_seconds)}>{formatRemaining(status.remaining_seconds)}</dd>
        </div>
        <div>
          <dt>実行中の作業</dt>
          <dd data-field="current_task" data-value={status.current_task ?? ''}>
            {status.current_task === null ? '—' : taskLabelOf(status.current_task).label}
          </dd>
        </div>
        <div>
          <dt>ツールの実行</dt>
          <dd data-field="tool-count">{`${calls.length} 件`}</dd>
        </div>
      </dl>
      {failure
        ? (
          <p className="notice" data-field="execution_failure" data-failure={failure}>
            <ResultMark outcome="failed" />
            <span>{FAILURE_LEAD}{FAILURE_TEXT[failure]}</span>
          </p>
        )
        : null}
      {props.faultTrials?.length
        ? (
          <section className="fault-history" aria-label={FAULTS_HEADING}>
            <h3>{FAULTS_HEADING}</h3>
            {props.faultTrials.map((trial) => (
              <div key={trial.instruction_id} className="trial-row" data-trial-state={trial.state} data-trial-kind={trial.kind}>
                <ResultMark outcome={trial.state === 'failed' ? 'failed' : trial.state === 'queued' ? 'running' : 'info'} />
                <div>
                  <strong>{trialText(trial)}</strong>
                  <span className="trial-kind">{FAULT_KIND_TEXT[trial.kind].label}</span>
                  <TrialTracker trial={trial} />
                  <p>
                    <time dateTime={trial.created_at}>{formatTime(trial.created_at)}</time>
                    {' · '}
                    <span data-field="trial-task" data-value={trial.task_id}>{taskLabelOf(trial.task_id).label}</span>
                  </p>
                  <small>要求 ID: <code>{trial.instruction_id}</code></small>
                  {trial.state === 'received' ? <p className="muted">{FAULT_KIND_TEXT[trial.kind].watch}</p> : null}
                </div>
              </div>
            ))}
          </section>
        )
        : null}
      <h3>{TOOLS_HEADING}</h3>
      <OutcomeBar counts={counts} label="ツール実行の結果" />
      {calls.length === 0
        ? <p className="status-empty" data-field="tools-empty">{TOOLS_EMPTY}</p>
        : (
          <ol className="tool-invocations">
            {calls.map((invocation, index) => (
              <li key={`${invocation.tool_id}:${index}`} data-tool-id={invocation.tool_id} data-outcome={invocation.outcome}>
                <span className="tool-step">{`${index + 1} 手目`}</span>
                <span className={`badge ${emphasisClass(invocation.outcome, 'tool_call')}`} data-field="tool-outcome">
                  {toolOutcomeLabelOf(invocation.outcome)}
                </span>
                <code className="tool-id">{invocation.tool_id}</code>
                {invocation.summary === '' ? null : <code className="tool-summary">{invocation.summary}</code>}
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}
