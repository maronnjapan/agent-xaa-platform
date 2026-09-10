import type { FaultTrial } from '../../agents/faults.js';
import type { ExecutionFailure } from '@xaa/contracts';
import type { AgentStatusResponse } from '../../agents/status.js';
import { Metric, ResultMark, formatTime } from './visual.js';
import { OutcomeBadge } from './outcome-badge.js';
import { OutcomeBar } from './outcome-bar.js';
import { FAULT_KIND_TEXT, TrialTracker } from './trial-tracker.js';
import type { Element } from '../element.js';

const FAILURE_TEXT: Readonly<Record<ExecutionFailure, string>> = {
  injected_runtime_crash: '異常系試験の要求により、Runtime が例外を投げて実行を中断しました。',
  injected_model_unavailable: '異常系試験の要求により、モデルを呼ばずに応答なしとして打ち切りました。',
};

/** What each state of a request says, in the row's own words. */
function trialText(trial: FaultTrial): string {
  switch (trial.state) {
    case 'queued': return '適用待ち';
    case 'received': return 'Runtimeが受信済み';
    case 'failed': return FAULT_KIND_TEXT[trial.kind].confirmed;
    case 'not_applied': return '対象Taskが実行中ではないため未適用';
  }
}

/**
 * The agent as it is right now: one read, no history.
 *
 * This panel and the timeline answer different questions and must not be confused —
 * this one is a snapshot that includes work still in flight; the timeline replays only
 * what has finished. It reads the status endpoint and nothing else, so there is no way
 * for a partial event stream to leak into it.
 */
export function StatusPanel(props: { status: AgentStatusResponse; faultTrials?: FaultTrial[] }): Element {
  const calls = props.status.tool_invocations;
  const failure = props.status.execution_failure;
  const counts = {
    success: calls.filter((call) => call.outcome === 'success').length,
    blocked: calls.filter((call) => call.outcome === 'blocked').length,
    failed: calls.filter((call) => call.outcome === 'failed').length,
  };
  return (
    <section data-section="status" className="status-panel card">
      <div className="section-heading">
        <h2>状況確認</h2>
        <span className="state-pill" data-field="agent_status" data-state={props.status.agent_status}>
          {props.status.agent_status}
        </span>
      </div>
      <div className="metric-grid">
        <Metric label="ツール実行" value={calls.length} />
        <Metric label="成功" value={counts.success} tone="green" />
        <Metric label="遮断" value={counts.blocked} tone="amber" />
        <Metric label="失敗" value={counts.failed} tone="red" />
      </div>
      <OutcomeBar counts={counts} label="ツール実行の結果" />
      <dl className="decision-facts">
        <dt>実行中のタスク</dt>
        <dd data-field="current_task">{props.status.current_task ?? '—'}</dd>
        <dt>残り時間（秒）</dt>
        <dd data-field="remaining_seconds">{String(props.status.remaining_seconds)}</dd>
      </dl>
      {failure ? (
        <p className="notice" data-field="execution_failure" data-failure={failure}>
          <ResultMark outcome="failed" />
          直近の実行は失敗しました。{FAILURE_TEXT[failure]}
        </p>
      ) : null}
      {props.faultTrials?.length ? (
        <section className="fault-history" aria-label="異常系試験の状態">
          <h3>異常系試験の状態</h3>
          {props.faultTrials.map((trial) => (
            <div key={trial.instruction_id} className="trial-row" data-trial-state={trial.state} data-trial-kind={trial.kind}>
              <ResultMark outcome={trial.state === 'failed' ? 'failed' : trial.state === 'queued' ? 'running' : 'info'} />
              <div>
                <strong>{trialText(trial)}</strong>
                <span className="trial-kind">{FAULT_KIND_TEXT[trial.kind].label}</span>
                <TrialTracker trial={trial} />
                <p><time dateTime={trial.created_at}>{formatTime(trial.created_at)}</time> · {trial.task_id}</p>
                <small>要求 ID: {trial.instruction_id}</small>
                {trial.state === 'received' ? <p className="muted">{FAULT_KIND_TEXT[trial.kind].watch}</p> : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
      <div className="section-heading"><h3>ツール実行の概要</h3><span className="muted">{calls.length} STEPS</span></div>
      {calls.length > 0 ? <ol className="execution-strip" aria-label="ツール実行の結果一覧">
        {calls.map((call, index) => <li key={index} data-outcome={call.outcome}><ResultMark outcome={call.outcome} /><span>{String(index + 1).padStart(2, '0')}</span><span className="sr-only">{call.tool_id} {call.outcome}</span></li>)}
      </ol> : null}
      <p className="muted">最新の実行スナップショット。完了した処理の履歴はアクティビティで確認できます。</p>
      {calls.length === 0 ? <p className="empty-state">まだツール実行の記録がありません。</p> : null}
      <ol className="tool-invocations event-stream">
        {calls.map((invocation, index) => (
          <li key={`${invocation.tool_id}:${index}`} data-tool-id={invocation.tool_id} data-outcome={invocation.outcome}>
            <ResultMark outcome={invocation.outcome} />
            <div className="event-content">
              <div className="section-heading">
                <strong>{invocation.tool_id}</strong>
                <OutcomeBadge outcome={invocation.outcome} phase="tool_call" />
              </div>
              <p>{invocation.summary || '詳細メッセージなし'}</p>
              <small className="muted">STEP {String(index + 1).padStart(2, '0')}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
