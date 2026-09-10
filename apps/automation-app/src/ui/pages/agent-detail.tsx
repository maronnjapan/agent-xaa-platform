import { useMonitor } from '../hooks/use-monitor.js';
import { agentMonitorPath } from '../../agents/page-link.js';
import { FaultControls } from '../components/fault-controls.js';
import type { FaultTrial } from '../../agents/faults.js';
import type { AgentStatusResponse } from '../../agents/status.js';
import { AgentControls } from '../components/agent-controls.js';
import { CastPanel } from '../components/cast-panel.js';
import { ExecutionLog } from '../components/execution-log.js';
import { StatusPanel } from '../components/status-panel.js';
import { TimelineLink } from '../components/timeline-link.js';
import { BlockedGuidance } from '../components/blocked-guidance.js';
import type { Element } from '../element.js';

export const AGENT_DETAIL_TITLE = 'Agent の状況';
export const AGENT_DETAIL_LEAD = 'いまの状態と、これまでの1手ずつの中身です。動いている最中でも読め、5 秒ごとに読み直します。';
export const MONITOR_REFRESH_LABEL = 'いま読み直す';
export const MONITOR_AUTO_LABEL = '5 秒ごとに読み直す';

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
 *
 * Unlike the activity screen, this one re-reads its snapshot every five seconds while
 * the person leaves the switch on (docs 11 §5.6): it is the screen for watching an
 * agent that is still going, and a snapshot that had to be refreshed by hand would be
 * stale by the time a person wondered whether it was. The reads go to this app's own
 * monitor endpoint and nowhere else (DEV-13).
 */
export function AgentDetailPage(props: { agentId: string; status: AgentStatusResponse; faultInjectionEnabled?: boolean; faultTrials?: FaultTrial[] }): Element {
  const monitor = useMonitor(agentMonitorPath(props.agentId), { status: props.status, faultTrials: props.faultTrials ?? [] });
  const { status, faultTrials } = monitor.data;
  const blocked = status.tool_invocations.some((invocation) => invocation.outcome === 'blocked');
  const sources = status.execution_log.flatMap((record) =>
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
        <div className="page-tools">
          <button type="button" className="secondary" data-action="monitor-refresh" disabled={monitor.busy} onClick={() => void monitor.refresh()}>{MONITOR_REFRESH_LABEL}</button>
        </div>
      </header>
      <div className="monitor-toolbar">
        <label>
          <input type="checkbox" data-monitor-auto="true" checked={monitor.auto} onChange={(event) => monitor.setAuto(event.target.checked)} />
          {MONITOR_AUTO_LABEL}
        </label>
        <span className="monitor-status" data-monitor-status="true" role="status">{monitor.message}</span>
      </div>
      <StatusPanel status={status} faultTrials={faultTrials} />
      <CastPanel sources={sources.length === 0 ? ['agent-runtime', 'agent-op', 'resource-as', 'resource-api'] : sources} />
      <ExecutionLog records={status.execution_log} />
      <AgentControls agentId={props.agentId} />
      {blocked ? <BlockedGuidance /> : null}
      {props.faultInjectionEnabled ? <FaultControls key={status.current_task ?? 'finished'} agentId={props.agentId} onAccepted={monitor.refresh} /> : null}
      <TimelineLink agentId={props.agentId} />
    </main>
  );
}
