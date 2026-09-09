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
 * The list of what each part is sits between the two, because the log below it names
 * the Agent OP and the Resource AS in every line and assumes the reader knows both. It
 * names only the parts this agent's own steps went through, read off the routes the
 * records list.
 */
export function AgentDetailPage(props: { agentId: string; status: AgentStatusResponse; faultInjectionEnabled?: boolean; faultTrials?: FaultTrial[] }): Element {
  const monitor = useMonitor(agentMonitorPath(props.agentId), { status: props.status, faultTrials: props.faultTrials ?? [] });
  const { status, faultTrials } = monitor.data;
  const blocked = status.tool_invocations.some((invocation) => invocation.outcome === 'blocked');
  const sources = status.execution_log.flatMap((record) =>
    (record.hops ?? []).flatMap((hop) => [hop.from, hop.to]));
  return (
    <main className="agent-detail" data-agent-id={props.agentId}>
      <header className="page-heading"><div><span className="eyebrow">AGENT EXECUTION</span><h1>エージェントの実行状況</h1><p className="agent-identifier">{props.agentId}</p></div>
        <button type="button" data-action="monitor-refresh" disabled={monitor.busy} onClick={() => void monitor.refresh()}>更新</button></header>
      <div className="monitor-toolbar"><label><input type="checkbox" data-monitor-auto="true" checked={monitor.auto} onChange={(event) => monitor.setAuto(event.target.checked)} /> 5秒ごとに更新</label><span data-monitor-status="true" role="status">{monitor.message}</span></div>
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
