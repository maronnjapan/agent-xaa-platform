import type { AgentStatusResponse } from '../../agents/status.js';
import { agentStatusLabelOf, formatRemaining, taskLabelOf, toolOutcomeLabelOf } from '../labels.js';
import { emphasisClass } from '../replay/emphasis.js';
import type { Element } from '../element.js';

export const STATUS_HEADING = '状況確認';
export const TOOLS_HEADING = '使ったツール';
export const TOOLS_EMPTY = 'まだツールを使っていません。';

/**
 * The agent as it is right now: one fetch, four values, no history.
 *
 * This panel and the timeline answer different questions and must not be confused —
 * this one is a snapshot that includes work still in flight; the timeline replays only
 * what has finished. It reads the status endpoint and nothing else, so there is no way
 * for a partial event stream to leak into it.
 *
 * The values are printed in words — 稼働中 rather than `ACTIVE`, 58 分 rather than
 * `3480`, 作業 1 rather than `task-1` — with the code kept on the element for anyone
 * matching the screen against a log. The words name the value; they do not judge it.
 */
export function StatusPanel(props: { status: AgentStatusResponse }): Element {
  const status = props.status;
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
      </dl>
      <h3>{TOOLS_HEADING}</h3>
      {status.tool_invocations.length === 0
        ? <p className="status-empty" data-field="tools-empty">{TOOLS_EMPTY}</p>
        : (
          <ol className="tool-invocations">
            {status.tool_invocations.map((invocation, index) => (
              <li key={`${invocation.tool_id}:${index}`} data-tool-id={invocation.tool_id} data-outcome={invocation.outcome}>
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
