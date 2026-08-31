import thresholds from '../../../../security-rules/thresholds.json' with { type: 'json' };
import type { AgentBaseline } from '../baseline/types.js';
import type { NormalizedEvent } from '../normalize/index.js';
import type { ProtocolViolationRecord } from '../pipeline/types.js';
import { groupByWindow } from './window.js';
import type { RuleCategory, RuleHit, RuleLevel } from './types.js';

export const THRESHOLDS = thresholds as Record<string, {
  medium_multiplier: number; high_multiplier: number; metrics?: string[]; codes?: string[];
}>;

export interface RuleCounters {
  baseline_missing_total: number;
}

export interface RuleInput {
  events: readonly NormalizedEvent[];
  violations: readonly ProtocolViolationRecord[];
  baselines: ReadonlyMap<string, AgentBaseline>;
}

/**
 * Counts, compared with what this agent's baseline says is normal.
 *
 * An agent with no baseline produces no hits at all, and a counter is incremented
 * instead. Substituting a default would mean every freshly provisioned agent is measured
 * against a number nobody chose for it — quiet ones would look suspicious and busy ones
 * would not, and neither answer would mean anything.
 *
 * The comparison is strictly greater than. An agent that hits its ceiling exactly is at
 * its limit, not over it, and a detector that fires on the boundary would fire on every
 * agent working at capacity.
 */
export function detectRuleHits(input: RuleInput): { hits: RuleHit[]; counters: RuleCounters } {
  const counters: RuleCounters = { baseline_missing_total: 0 };
  const hits: RuleHit[] = [];

  for (const [key, events] of groupByWindow(
    input.events.filter((event) => event.actor.agent_id !== null),
    (event) => event.actor.agent_id!,
    (event) => event.time,
  )) {
    const agentId = key.slice(key.indexOf('|') + 1);
    const baseline = input.baselines.get(agentId);
    if (!baseline) { counters.baseline_missing_total += 1; continue; }
    hits.push(...tokenHits(agentId, events, baseline));
  }

  hits.push(...codeHits(input.violations));
  return { hits, counters };
}

const TOKEN_METRIC_SOURCE: Readonly<Record<string, (event: NormalizedEvent) => boolean>> = {
  token_request: (event) => event.metadata.log_source === 'agent_op',
  id_jag_issued: (event) => event.metadata.log_source === 'agent_op' && event.api.status === 'issued',
  google_refresh_failure: (event) => event.metadata.log_source === 'google_bridge' && event.api.status === 'error',
  subject_token_refetch: (event) => event.api.operation === 'subject_token',
  auth_failure: (event) => event.severity_id >= 4,
};

function tokenHits(agentId: string, events: readonly NormalizedEvent[], baseline: AgentBaseline): RuleHit[] {
  const rule = THRESHOLDS.token!;
  const hits: RuleHit[] = [];
  const last = events.at(-1)!;
  for (const metric of rule.metrics ?? []) {
    const count = events.filter((event) => TOKEN_METRIC_SOURCE[metric]?.(event) ?? false).length;
    // Every token metric is measured against the ID-JAG ceiling: they all describe how
    // often this agent asks for credentials.
    const max = baseline.expected_rate.id_jag.max;
    const level: RuleLevel | null = count > max * rule.high_multiplier
      ? 'HIGH'
      : count > max * rule.medium_multiplier ? 'MEDIUM' : null;
    if (!level) continue;
    hits.push({
      rule_id: `token.${metric}.${level.toLowerCase()}`,
      category: 'token', level, agent_id: agentId,
      human_subject: last.actor.human_subject ?? '',
      occurred_at: last.time, trace_id: last.metadata.trace_id,
      related_events: events.map((event) => event.metadata.correlation_uid),
      detail: { metric, count, max },
    });
  }
  return hits;
}

/**
 * The other five categories are code-driven rather than count-driven.
 *
 * A protocol violation is already a judgement the issuing service made synchronously
 * (DEC-SEC-02); this pass only classifies it and decides how loud to be. Re-deciding
 * whether the violation happened would mean two components disagreeing about the same
 * request.
 */
const CATEGORY_FOR_CODE = new Map<string, RuleCategory>();
for (const [category, rule] of Object.entries(THRESHOLDS)) {
  for (const code of rule.codes ?? []) CATEGORY_FOR_CODE.set(code, category as RuleCategory);
}

function codeHits(violations: readonly ProtocolViolationRecord[]): RuleHit[] {
  const byKey = groupByWindow(
    violations.filter((violation) => violation.agent_id !== null),
    (violation) => `${violation.agent_id}|${violation.code}`,
    (violation) => violation.occurred_at,
  );
  const hits: RuleHit[] = [];
  for (const [, group] of byKey) {
    const first = group[0]!;
    const category = CATEGORY_FOR_CODE.get(first.code);
    if (!category) continue;
    const rule = THRESHOLDS[category]!;
    const level: RuleLevel = group.length >= rule.high_multiplier ? 'HIGH' : 'MEDIUM';
    hits.push({
      rule_id: `${category}.${first.code}.${level.toLowerCase()}`,
      category, level, agent_id: first.agent_id!,
      human_subject: first.human_subject ?? '',
      occurred_at: group.at(-1)!.occurred_at, trace_id: first.trace_id,
      related_events: group.map((violation) => violation.event.metadata.correlation_uid),
      detail: { code: first.code, count: group.length },
    });
  }
  return hits;
}

/** Every rule id this engine can produce, for the score map's completeness check. */
export function allRuleIds(): string[] {
  const ids: string[] = [];
  for (const metric of THRESHOLDS.token?.metrics ?? []) {
    ids.push(`token.${metric}.medium`, `token.${metric}.high`);
  }
  for (const [category, rule] of Object.entries(THRESHOLDS)) {
    for (const code of rule.codes ?? []) ids.push(`${category}.${code}.medium`, `${category}.${code}.high`);
  }
  return ids.sort();
}
