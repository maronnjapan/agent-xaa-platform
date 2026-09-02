import { hitId, type RuleHit } from '../rules/types.js';
import { groupByWindow, parseWindowKey } from '../rules/window.js';
import { findingId, type SecurityFinding } from './finding.js';

export interface CrossAgentResult {
  findings: SecurityFinding[];
  /** Hit ids already accounted for, so the per-agent pass does not count them again. */
  consumed: string[];
}

/**
 * Two views wider than a single agent.
 *
 * One agent reaching another's dedicated OP is an isolation hit. The same person's
 * agents doing it to each other is lateral movement, and reporting it once as a single
 * finding is what makes it legible — two separate per-agent findings would describe the
 * same event from both ends and look like twice as much trouble.
 *
 * The platform-wide view catches the case that matters most: one dedicated OP touched by
 * agents belonging to different people. That cannot be an accident of one person's
 * workflow.
 */
export function correlateCrossAgent(input: {
  hits: readonly RuleHit[];
  createdAt: string;
}): CrossAgentResult {
  const isolation = input.hits.filter((hit) => hit.category === 'isolation');
  const findings: SecurityFinding[] = [];
  const consumed: string[] = [];

  for (const [key, group] of groupByWindow(isolation, (hit) => hit.human_subject, (hit) => hit.occurred_at)) {
    // One agent's isolation hit stays where it is; it needs no wider story.
    if (group.length < 2) continue;
    const agents = new Set(group.flatMap(involvedAgents));
    if (agents.size < 2) continue;
    const { windowStart, windowEnd, subject } = parseWindowKey(key);
    findings.push(finding({
      type: 'cross_agent_lateral_movement', windowStart, windowEnd, subject,
      humanSubject: subject, agentId: null, group, createdAt: input.createdAt,
    }));
    consumed.push(...group.map(hitId));
  }

  const byDedicated = new Map<string, RuleHit[]>();
  for (const hit of isolation) {
    const short = hit.detail.dedicated_short_id;
    if (typeof short !== 'string') continue;
    byDedicated.set(short, [...(byDedicated.get(short) ?? []), hit]);
  }
  for (const [short, group] of byDedicated) {
    if (new Set(group.map((hit) => hit.human_subject)).size < 2) continue;
    const windowStart = Math.floor(Date.parse(group[0]!.occurred_at) / 600_000) * 600_000;
    findings.push(finding({
      type: 'platform_wide_isolation_breach', windowStart, windowEnd: windowStart + 600_000,
      subject: 'global', humanSubject: '', agentId: null, group, createdAt: input.createdAt,
      detailKey: short,
    }));
    consumed.push(...group.map(hitId));
  }

  return { findings, consumed };
}

/**
 * Every agent a hit is about, not only the one that produced the line.
 *
 * docs 09 §5.3 describes the case this exists for: Agent A reaching the dedicated OPs of
 * B, C and D. All four hits carry `agent_id = A`, so counting only the producer would see
 * one agent and call four lateral movements four separate anomalies — which is precisely
 * the shape the design says a single agent's log cannot show.
 */
function involvedAgents(hit: RuleHit): string[] {
  const observed = hit.detail.observed;
  const foreign = typeof observed === 'string' && observed.startsWith('agent-') ? [observed] : [];
  return [hit.agent_id, ...foreign];
}

function finding(input: {
  type: SecurityFinding['finding_type'];
  windowStart: number;
  windowEnd: number;
  subject: string;
  humanSubject: string;
  agentId: string | null;
  group: readonly RuleHit[];
  createdAt: string;
  detailKey?: string;
}): SecurityFinding {
  return {
    finding_id: findingId(input.windowStart, input.subject),
    finding_type: input.type,
    agent_id: input.agentId,
    human_subject: input.humanSubject,
    window_start: new Date(input.windowStart).toISOString(),
    window_end: new Date(input.windowEnd).toISOString(),
    related_events: [...new Set(input.group.flatMap((hit) => hit.related_events))].sort(),
    contributing_codes: [...new Set(input.group.map((hit) => hit.rule_id))].sort(),
    risk_score: null,
    risk_level: null,
    review_status: 'none',
    created_at: input.createdAt,
  };
}
