import type { AgentStatusResponse } from '../../agents/status.js';
import { AgentControls } from '../components/agent-controls.js';
import { StatusPanel } from '../components/status-panel.js';
import { TimelineLink } from '../components/timeline-link.js';
import { BlockedGuidance } from '../components/blocked-guidance.js';
import type { Element } from '../element.js';


/**
 * Status above, the two operations under it, timeline link below, and the guidance only
 * when something was refused.
 *
 * The two sections carry distinct `data-section` attributes and share no data: the
 * status panel never reads timeline events, and the timeline link never reads the
 * checkpoint. Keeping them apart in the DOM is how the distinction survives later edits.
 */
export function AgentDetailPage(props: { agentId: string; status: AgentStatusResponse }): Element {
  const blocked = props.status.tool_invocations.some((invocation) => invocation.outcome === 'blocked');
  return (
    <main class="agent-detail" data-agent-id={props.agentId}>
      <StatusPanel status={props.status} />
      <AgentControls agentId={props.agentId} />
      {blocked ? <BlockedGuidance /> : null}
      <TimelineLink agentId={props.agentId} />
    </main>
  );
}
