import type { AgentStatusResponse } from '../../agents/status.js';
import { AgentControls } from '../components/agent-controls.js';
import { ExecutionLog } from '../components/execution-log.js';
import { StatusPanel } from '../components/status-panel.js';
import { TimelineLink } from '../components/timeline-link.js';
import { BlockedGuidance } from '../components/blocked-guidance.js';
import type { Element } from '../element.js';


/**
 * Status, then what the agent has actually been doing, then the two operations, the
 * timeline link, and the guidance only when something was refused.
 *
 * The sections carry distinct `data-section` attributes and share no source: the status
 * panel and the execution log both read the checkpoint, and the timeline link reads
 * nothing at all. Keeping them apart in the DOM is how the distinction survives later
 * edits — and the execution log is emphatically not a timeline, which is why it carries
 * no task id and no row a person could mistake for one (RULE-59).
 */
export function AgentDetailPage(props: { agentId: string; status: AgentStatusResponse }): Element {
  const blocked = props.status.tool_invocations.some((invocation) => invocation.outcome === 'blocked');
  return (
    <main class="agent-detail" data-agent-id={props.agentId}>
      <StatusPanel status={props.status} />
      <ExecutionLog records={props.status.execution_log} />
      <AgentControls agentId={props.agentId} />
      {blocked ? <BlockedGuidance /> : null}
      <TimelineLink agentId={props.agentId} />
    </main>
  );
}
