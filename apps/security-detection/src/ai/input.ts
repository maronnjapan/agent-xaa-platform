import { compile } from '@xaa/contracts';
import type { AgentBaseline } from '../baseline/types.js';
import type { SecurityFinding } from '../correlate/finding.js';

export const AI_INPUT_KEYS = [
  'security_finding', 'risk_score', 'related_events_summary', 'agent_baseline',
  'agent_definition', 'work_definition_summary', 'proposed_capabilities',
  'effective_capabilities', 'allowed_tools', 'isolation_level',
  'relevant_authorization_decisions', 'audience', 'resource', 'scope',
  'agent_age_seconds', 'time_series',
] as const;

export interface RelatedEventSummary {
  occurred_at: string;
  code: string;
  tool_id: string;
  resource: string;
  status: string;
}

export interface SecurityAiInput {
  security_finding: SecurityFinding;
  risk_score: number;
  related_events_summary: RelatedEventSummary[];
  agent_baseline: AgentBaseline;
  agent_definition: Record<string, unknown>;
  /** A hash and a list of operation kinds — never the text of the work itself. */
  work_definition_summary: { hash: string; operation_kinds: string[] };
  proposed_capabilities: string[];
  effective_capabilities: string[];
  allowed_tools: string[];
  isolation_level: string;
  relevant_authorization_decisions: string[];
  audience: string[];
  resource: string[];
  scope: string[];
  agent_age_seconds: number;
  time_series: Array<{ bucket: string; count: number }>;
}

export const AI_INPUT_LIMIT_BYTES = 8192;

export class AiInputTooLarge extends Error {
  readonly code = 'ai_input_too_large';
}

export const securityAiInputSchema = {
  $id: 'security-ai-input',
  type: 'object',
  additionalProperties: false,
  required: [...AI_INPUT_KEYS],
  properties: {
    security_finding: { type: 'object' },
    risk_score: { type: 'integer', minimum: 0, maximum: 100 },
    related_events_summary: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['occurred_at', 'code', 'tool_id', 'resource', 'status'],
        properties: {
          occurred_at: { type: 'string' }, code: { type: 'string' }, tool_id: { type: 'string' },
          resource: { type: 'string' }, status: { type: 'string' },
        },
      },
    },
    agent_baseline: { type: 'object' },
    agent_definition: { type: 'object' },
    work_definition_summary: {
      type: 'object', additionalProperties: false, required: ['hash', 'operation_kinds'],
      properties: { hash: { type: 'string' }, operation_kinds: { type: 'array', items: { type: 'string' } } },
    },
    proposed_capabilities: { type: 'array', items: { type: 'string' } },
    effective_capabilities: { type: 'array', items: { type: 'string' } },
    allowed_tools: { type: 'array', items: { type: 'string' } },
    isolation_level: { type: 'string' },
    relevant_authorization_decisions: { type: 'array', items: { type: 'string' } },
    audience: { type: 'array', items: { type: 'string' } },
    resource: { type: 'array', items: { type: 'string' } },
    scope: { type: 'array', items: { type: 'string' } },
    agent_age_seconds: { type: 'integer', minimum: 0 },
    time_series: { type: 'array' },
  },
} as const;

const assertInput: (value: unknown) => asserts value is SecurityAiInput =
  compile<SecurityAiInput>(securityAiInputSchema);

/**
 * A summary, built from three records, and never from the raw log.
 *
 * RULE-39: the model reasons over a description of what happened, not over the events
 * themselves. The signature is what enforces it — there is no parameter of type
 * `NormalizedEvent[]` to pass, so the lint rule that forbids importing the normaliser
 * into this directory has something real to protect.
 *
 * Truncation drops the oldest summaries first and nothing else. The finding, the
 * baseline and the capability lists are what make the events interpretable; dropping
 * them to fit would leave the model with detail and no context.
 */
export function buildAiInput(input: {
  finding: SecurityFinding;
  baseline: AgentBaseline;
  registration: Record<string, unknown>;
  relatedEvents: readonly RelatedEventSummary[];
  workDefinitionHash: string;
  operationKinds: readonly string[];
  proposedCapabilities?: readonly string[];
  agentAgeSeconds: number;
  timeSeries?: Array<{ bucket: string; count: number }>;
}): SecurityAiInput {
  const summaries = [...input.relatedEvents];
  const build = (): SecurityAiInput => ({
    security_finding: input.finding,
    risk_score: input.finding.risk_score ?? 0,
    related_events_summary: summaries,
    agent_baseline: input.baseline,
    agent_definition: input.registration,
    work_definition_summary: { hash: input.workDefinitionHash, operation_kinds: [...input.operationKinds] },
    proposed_capabilities: [...(input.proposedCapabilities ?? [])],
    effective_capabilities: [...input.baseline.effective_capabilities],
    allowed_tools: [...input.baseline.expected_tools],
    isolation_level: String(input.registration.isolation_level ?? 'standard'),
    relevant_authorization_decisions: [String(input.registration.decision_id ?? '')].filter(Boolean),
    audience: [...((input.registration.allowed_audiences as string[]) ?? [])],
    resource: [...input.baseline.expected_resources],
    scope: [...((input.registration.scopes as string[]) ?? [])],
    agent_age_seconds: input.agentAgeSeconds,
    time_series: input.timeSeries ?? [],
  });

  let value = build();
  while (Buffer.byteLength(JSON.stringify(value), 'utf8') > AI_INPUT_LIMIT_BYTES) {
    if (summaries.length === 0) {
      // Nothing left to trim: calling the model with a truncated context would produce a
      // confident answer about evidence it did not receive.
      throw new AiInputTooLarge('input exceeds the limit with no events left to drop');
    }
    summaries.shift();
    value = build();
  }
  assertInput(value);
  return value;
}
