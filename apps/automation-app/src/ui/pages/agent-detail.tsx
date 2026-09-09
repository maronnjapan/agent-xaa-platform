import type { AgentStatusResponse } from '../../agents/status.js';
import { AgentControls } from '../components/agent-controls.js';
import { CastPanel } from '../components/cast-panel.js';
import { ExecutionLog } from '../components/execution-log.js';
import { StatusPanel } from '../components/status-panel.js';
import { TimelineLink } from '../components/timeline-link.js';
import { BlockedGuidance } from '../components/blocked-guidance.js';
import type { Element } from '../element.js';

export const AGENT_DETAIL_TITLE = 'Agent の状況';
export const AGENT_DETAIL_LEAD = 'いまの状態と、これまでの1手ずつの中身です。動いている最中でも読めます。';

/**
 * Status, then what the agent has actually been doing, then the two operations, the
 * timeline link, and the guidance only when something was refused.
 *
 * The sections carry distinct `data-section` attributes and share no source: the status
 * panel and the execution log both read the checkpoint, and the timeline link reads
 * nothing at all. Keeping them apart in the DOM is how the distinction survives later
 * edits — and the execution log is emphatically not a timeline, which is why it carries
 * no task id and no row a person could mistake for one (RULE-59).
 *
 * The agent's id is in the head as the thing a person may need to copy, not as the
 * thing they are meant to read: the words above it say what the page is.
 */
export function AgentDetailPage(props: { agentId: string; status: AgentStatusResponse }): Element {
  const blocked = props.status.tool_invocations.some((invocation) => invocation.outcome === 'blocked');
  const sources = props.status.execution_log.flatMap((record) =>
    (record.hops ?? []).flatMap((hop) => [hop.from, hop.to]));
  return (
    <main className="agent-detail" data-agent-id={props.agentId}>
      <header className="page-head">
        <div className="page-head-text">
          <h1>{AGENT_DETAIL_TITLE}</h1>
          <p className="lead">{AGENT_DETAIL_LEAD}</p>
          <p className="page-id">
            <span>Agent ID</span>
            <code data-field="agent-id">{props.agentId}</code>
          </p>
        </div>
      </header>
      <StatusPanel status={props.status} />
      <CastPanel sources={sources.length === 0 ? ['agent-runtime', 'agent-op', 'resource-as', 'resource-api'] : sources} />
      <ExecutionLog records={props.status.execution_log} />
      <AgentControls agentId={props.agentId} />
      {blocked ? <BlockedGuidance /> : null}
      <TimelineLink agentId={props.agentId} />
    </main>
  );
}
