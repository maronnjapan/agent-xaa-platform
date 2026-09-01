import type { Deviation } from '../baseline/deviation.js';
import { hitId, type RuleHit } from '../rules/types.js';
import { groupByWindow, parseWindowKey } from '../rules/window.js';
import type { ProtocolViolationRecord } from '../pipeline/types.js';
import { classify, findingId, type SecurityFinding } from './finding.js';
import { correlateCrossAgent } from './cross-agent.js';

export interface CorrelateInput {
  hits: readonly RuleHit[];
  violations: readonly ProtocolViolationRecord[];
  /** Keyed by agent id; attached to that agent's finding and to no other. */
  deviations?: ReadonlyMap<string, readonly Deviation[]>;
  now?: () => number;
}

/**
 * Groups a window's evidence into findings, in a fixed order.
 *
 * `bySubject` runs before `byAgent` on purpose: a hit that already explained a
 * cross-agent movement should not also appear as a separate anomaly for one of the
 * agents involved. Counting it twice would inflate the score of both findings and make
 * one incident look like several.
 */
export function correlate(input: CorrelateInput): SecurityFinding[] {
  const now = input.now ?? (() => Date.now());
  const createdAt = new Date(now()).toISOString();

  const cross = correlateCrossAgent({ hits: input.hits, createdAt });
  const consumed = new Set(cross.consumed);

  const remaining = input.hits.filter((hit) => !consumed.has(hitId(hit)));
  const byAgent = new Map<string, { hits: RuleHit[]; violations: ProtocolViolationRecord[] }>();

  for (const [key, group] of groupByWindow(remaining, (hit) => hit.agent_id, (hit) => hit.occurred_at)) {
    byAgent.set(key, { hits: group, violations: [] });
  }
  for (const [key, group] of groupByWindow(
    input.violations.filter((violation) => violation.agent_id !== null),
    (violation) => violation.agent_id!,
    (violation) => violation.occurred_at,
  )) {
    const existing = byAgent.get(key) ?? { hits: [], violations: [] };
    byAgent.set(key, { ...existing, violations: group });
  }

  const findings: SecurityFinding[] = [];
  for (const [key, group] of byAgent) {
    // An agent with neither a hit nor a violation in this window has nothing to report.
    if (group.hits.length === 0 && group.violations.length === 0) continue;
    const { windowStart, windowEnd, subject } = parseWindowKey(key);
    const codes = [...new Set([
      ...group.hits.map((hit) => hit.rule_id),
      ...group.violations.map((violation) => violation.code),
    ])].sort();
    const events = [
      ...group.hits.flatMap((hit) => hit.related_events.map((id) => ({ id, at: hit.occurred_at, trace: hit.trace_id }))),
      ...group.violations.map((violation) => ({
        id: violation.event.metadata.correlation_uid, at: violation.occurred_at, trace: violation.trace_id,
      })),
    ];
    findings.push({
      finding_id: findingId(windowStart, subject),
      finding_type: classify(codes),
      agent_id: subject,
      human_subject: group.hits[0]?.human_subject ?? group.violations[0]?.human_subject ?? '',
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(windowEnd).toISOString(),
      related_events: sortEvents(events),
      contributing_codes: codes,
      risk_score: null,
      risk_level: null,
      review_status: 'none',
      created_at: createdAt,
      // A cross-agent finding gets none: it belongs to two agents, and one agent's
      // baseline says nothing about what the pair of them did.
      deviations: [...(input.deviations?.get(subject) ?? [])],
    });
  }
  return [...cross.findings, ...findings];
}

/** Ordered by time, then by trace id: the same input must always read the same way. */
function sortEvents(events: ReadonlyArray<{ id: string; at: string; trace: string }>): string[] {
  return [...events]
    .sort((left, right) => left.at.localeCompare(right.at) || left.trace.localeCompare(right.trace))
    .map((event) => event.id)
    .filter((id, index, all) => all.indexOf(id) === index);
}
