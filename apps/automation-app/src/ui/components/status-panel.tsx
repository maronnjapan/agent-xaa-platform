import type { AgentStatusResponse } from '../../agents/status.js';
import type { Element } from '../element.js';


/**
 * The agent as it is right now: one fetch, four values, no history.
 *
 * This panel and the timeline answer different questions and must not be confused —
 * this one is a snapshot that includes work still in flight; the timeline replays only
 * what has finished. It reads the status endpoint and nothing else, so there is no way
 * for a partial event stream to leak into it.
 */
export function StatusPanel(props: { status: AgentStatusResponse }): Element {
  return (
    <section data-section="status" class="status-panel">
      <h2>状況確認</h2>
      <dl>
        <dt>状態</dt><dd data-field="agent_status">{props.status.agent_status}</dd>
        <dt>残り時間（秒）</dt><dd data-field="remaining_seconds">{String(props.status.remaining_seconds)}</dd>
        <dt>実行中のタスク</dt><dd data-field="current_task">{props.status.current_task ?? '—'}</dd>
      </dl>
      <ol class="tool-invocations">
        {props.status.tool_invocations.map((invocation) => (
          <li data-tool-id={invocation.tool_id} data-outcome={invocation.outcome}>
            {invocation.tool_id}／{invocation.outcome}／{invocation.summary}
          </li>
        ))}
      </ol>
    </section>
  );
}
