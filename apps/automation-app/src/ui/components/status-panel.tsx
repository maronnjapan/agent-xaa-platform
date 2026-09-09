import type { FaultTrial } from '../../agents/faults.js';
import type { ExecutionFailure } from '@xaa/contracts';
import type { AgentStatusResponse } from '../../agents/status.js';
import { Metric, ResultMark, formatTime } from './visual.js';
import { OutcomeBadge } from './outcome-badge.js';
import type { Element } from '../element.js';

const FAILURE_TEXT: Readonly<Record<ExecutionFailure, string>> = {
  injected_runtime_crash: '異常系試験の要求により、実行を中断しました。',
};

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
  return (
    <section data-section="status" class="status-panel card">
      <div class="section-heading">
        <h2>状況確認</h2>
        <span class="state-pill" data-field="agent_status" data-state={props.status.agent_status}>
          {props.status.agent_status}
        </span>
      </div>
      <div class="metric-grid">
        <Metric label="ツール実行" value={calls.length} />
        <Metric label="成功" value={calls.filter((call) => call.outcome === 'success').length} tone="green" />
        <Metric label="遮断" value={calls.filter((call) => call.outcome === 'blocked').length} tone="amber" />
        <Metric label="失敗" value={calls.filter((call) => call.outcome === 'failed').length} tone="red" />
      </div>
      <dl class="decision-facts">
        <dt>実行中のタスク</dt>
        <dd data-field="current_task">{props.status.current_task ?? '—'}</dd>
        <dt>残り時間（秒）</dt>
        <dd data-field="remaining_seconds">{String(props.status.remaining_seconds)}</dd>
      </dl>
      {failure ? (
        <p class="notice" data-field="execution_failure" data-failure={failure}>
          <ResultMark outcome="failed" />
          直近の実行は失敗しました。{FAILURE_TEXT[failure]}
        </p>
      ) : null}
      {props.faultTrials?.length ? (
        <section class="fault-history" aria-label="異常系試験の状態">
          <h3>異常系試験の状態</h3>
          {props.faultTrials.map((trial) => (
            <div class="trial-row" data-trial-state={trial.state}>
              <ResultMark outcome={trial.state === 'failed' ? 'failed' : trial.state === 'queued' ? 'running' : 'info'} />
              <div><strong>{ { queued: '適用待ち', received: 'Runtimeが受信済み', failed: '実行の失敗を確認', not_applied: '対象Taskが実行中ではないため未適用' }[trial.state] }</strong>
                <p><time datetime={trial.created_at}>{formatTime(trial.created_at)}</time> · {trial.task_id}</p>
                <small>要求 ID: {trial.instruction_id}</small>
                {trial.state === 'received' ? <p class="muted">受信後の結果はアクティビティで確認してください。</p> : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
      <div class="section-heading"><h3>実行ログ</h3><span class="muted">{calls.length} STEPS</span></div>
      {calls.length > 0 ? <ol class="execution-strip" aria-label="ツール実行の結果一覧">
        {calls.map((call, index) => <li data-outcome={call.outcome}><ResultMark outcome={call.outcome} /><span>{String(index + 1).padStart(2, '0')}</span><span class="sr-only">{call.tool_id} {call.outcome}</span></li>)}
      </ol> : null}
      <p class="muted">最新の実行スナップショット。完了した処理の履歴はアクティビティで確認できます。</p>
      {calls.length === 0 ? <p class="empty-state">まだツール実行の記録がありません。</p> : null}
      <ol class="tool-invocations event-stream">
        {calls.map((invocation, index) => (
          <li data-tool-id={invocation.tool_id} data-outcome={invocation.outcome}>
            <ResultMark outcome={invocation.outcome} />
            <div class="event-content">
              <div class="section-heading">
                <strong>{invocation.tool_id}</strong>
                <OutcomeBadge outcome={invocation.outcome} phase="tool_call" />
              </div>
              <p>{invocation.summary || '詳細メッセージなし'}</p>
              <small class="muted">STEP {String(index + 1).padStart(2, '0')}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
