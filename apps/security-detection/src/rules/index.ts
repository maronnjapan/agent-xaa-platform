import type { AgentBaseline } from '../baseline/types.js';
import type { NormalizedEvent } from '../normalize/index.js';
import type { ProtocolViolationRecord } from '../pipeline/types.js';
import { detectAuthorizationHits } from './authorization.js';
import { detectAuthorizationAiHits } from './authorization-ai.js';
import { detectIsolationHits } from './isolation.js';
import { detectLifetimeHits } from './lifetime.js';
import { detectToolHits } from './tool.js';
import { THRESHOLDS } from './thresholds.js';
import { groupByWindow } from './window.js';
import type { AgentRegistrationView, RuleContext } from './context.js';
import type { RuleCategory, RuleHit, RuleLevel } from './types.js';

export { THRESHOLDS };
export type { RuleThreshold } from './thresholds.js';
export type { AgentRegistrationView, RuleContext } from './context.js';

export interface RuleCounters {
  baseline_missing_total: number;
}

export interface RuleInput {
  events: readonly NormalizedEvent[];
  violations: readonly ProtocolViolationRecord[];
  baselines: ReadonlyMap<string, AgentBaseline>;
  /** From `agents/{agent_id}/meta`; absent for an agent the detector could not read. */
  registrations?: ReadonlyMap<string, AgentRegistrationView>;
  maxLifetimeSeconds?: number | null;
}

/**
 * The six classifications, run over one batch.
 *
 * Only the `token` classification needs a baseline to say anything, because only it is
 * measured as a multiple of what this agent normally does. An agent with no baseline
 * produces no token hits and increments a counter instead: substituting a default would
 * mean every freshly provisioned agent is measured against a number nobody chose for it,
 * and quiet ones would look suspicious while busy ones would not.
 *
 * The other five are absolute — a tool outside the catalogue, an expiry already passed,
 * another agent's dedicated OP — so they run whether or not a baseline was found. Making
 * them wait for one would mean a missing Firestore document silences isolation detection.
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

  const context: RuleContext = {
    events: input.events,
    violations: input.violations,
    baselines: input.baselines,
    registrations: input.registrations ?? new Map(),
    maxLifetimeSeconds: input.maxLifetimeSeconds ?? null,
  };

  hits.push(
    ...detectAuthorizationHits(context),
    ...detectToolHits(context),
    ...detectLifetimeHits(context),
    ...detectIsolationHits(context),
    ...detectAuthorizationAiHits(context),
    ...codeHits(input.violations),
  );
  return { hits, counters };
}

const TOKEN_METRIC_SOURCE: Readonly<Record<string, (event: NormalizedEvent) => boolean>> = {
  token_request: (event) => event.metadata.log_source === 'agent_op',
  id_jag_issued: (event) => event.metadata.log_source === 'agent_op' && event.api.status === 'issued',
  google_refresh_failure: (event) => event.metadata.log_source === 'google_bridge' && event.api.status === 'error',
  subject_token_refetch: (event) => event.api.operation === 'subject_token',
  auth_failure: (event) => event.severity_id >= 4,
};

/**
 * Counts, compared with what this agent's baseline says is normal.
 *
 * The comparison is strictly greater than. An agent that hits its ceiling exactly is at
 * its limit, not over it, and a detector that fires on the boundary would fire on every
 * agent working at capacity.
 */
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
 * Refusals the platform's own services already recorded.
 *
 * A protocol violation is a judgement the issuing service made synchronously
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

/**
 * Rule ids that are the same however the thresholds are edited.
 *
 * Every classification but `token` and the counted half of `authorization` names its
 * verdict rather than describing a level, so the id a saved query keys on does not change
 * when somebody decides a condition should be HIGH instead of MEDIUM.
 */
export const FIXED_RULE_IDS: readonly string[] = [
  'authorization.scope_out_of_range', 'authorization.unknown_audience', 'authorization.unknown_resource',
  'tool.unknown_tool', 'tool.not_provisioned', 'tool.unexpected_resource',
  'lifetime.age_exceeded', 'lifetime.access_after_expiry',
  'isolation.cross_agent_idp', 'isolation.dedicated_op_mismatch', 'isolation.multi_subject_actor',
  'authz_ai.unknown_capability', 'authz_ai.out_of_taxonomy_format', 'authz_ai.large_gap',
];

/** Every rule id this engine can produce, for the score map's completeness check. */
export function allRuleIds(): string[] {
  const ids: string[] = [...FIXED_RULE_IDS, 'authorization.status_error.medium', 'authorization.status_error.high'];
  for (const metric of THRESHOLDS.token?.metrics ?? []) {
    ids.push(`token.${metric}.medium`, `token.${metric}.high`);
  }
  for (const [category, rule] of Object.entries(THRESHOLDS)) {
    for (const code of rule.codes ?? []) ids.push(`${category}.${code}.medium`, `${category}.${code}.high`);
  }
  return [...new Set(ids)].sort();
}
