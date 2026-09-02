import { describe, expect, it } from 'vitest';
import {
  AI_INPUT_KEYS, AI_INPUT_LIMIT_BYTES, AiInputTooLarge, buildAiInput,
  type RelatedEventSummary, type SecurityAiInput,
} from '../src/ai/input.js';
import { analyze } from '../src/ai/vertex-client.js';
import type { SecurityFinding } from '../src/correlate/finding.js';
import { AGENT_ID, baselineFor } from '../src/testing/harness.js';

const WORK_DEFINITION_BODY = '毎朝の日報を集めて要約する';

const finding: SecurityFinding = {
  finding_id: 'f_1', finding_type: 'anomalous_agent_activity', agent_id: AGENT_ID,
  human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
  related_events: [], contributing_codes: [], risk_score: 70, risk_level: 'HIGH',
  review_status: 'none', created_at: '2026-01-01T12:10:00.000Z',
};

function build(overrides: Partial<Parameters<typeof buildAiInput>[0]> = {}): SecurityAiInput {
  return buildAiInput({
    finding, baseline: baselineFor(),
    registration: {
      isolation_level: 'standard', decision_id: 'decision-1',
      allowed_audiences: ['https://resource-docs-as.test'], scopes: ['docs.read'],
    },
    relatedEvents: [{
      occurred_at: '2026-01-01T12:00:00.000Z', code: 'isolation.dedicated_op_mismatch',
      tool_id: 'internal.document.list', resource: 'https://resource-docs-api.test', status: '403',
    }],
    workDefinitionHash: 'a'.repeat(64),
    operationKinds: ['document.read'], proposedCapabilities: ['document.read'],
    agentAgeSeconds: 60, timeSeries: [{ bucket: '2026-01-01T12:00:00.000Z', count: 3 }],
    ...overrides,
  });
}

/**
 * T-SEC-32 / REQ-09-045. What the Security AI is allowed to see.
 *
 * The model reasons over a summary this application built, never over the log. That is
 * a property of the type, not of anyone's care: `buildAiInput` has no parameter of type
 * `NormalizedEvent[]`, and `analyze` accepts `SecurityAiInput` and nothing else.
 */
describe('the Security AI input', () => {
  it('all fifteen items are populated', () => {
    const input = build();
    // docs 09 §5.6 enumerates the items; the table below is that list, in order.
    expect(Object.keys(input).sort()).toEqual([...AI_INPUT_KEYS].sort());
    for (const key of AI_INPUT_KEYS) {
      const value = (input as unknown as Record<string, unknown>)[key];
      expect(value, key).toBeDefined();
      if (Array.isArray(value)) expect(value.length, key).toBeGreaterThan(0);
      if (typeof value === 'string') expect(value, key).not.toBe('');
    }
  });

  it('truncates to 8kb with 1000 related events', () => {
    const related: RelatedEventSummary[] = Array.from({ length: 1000 }, (_unused, index) => ({
      occurred_at: `2026-01-01T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
      code: `code-${index}`, tool_id: 'internal.document.list',
      resource: 'https://resource-docs-api.test', status: 'ok',
    }));
    const input = build({ relatedEvents: related });

    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThanOrEqual(AI_INPUT_LIMIT_BYTES);
    // The oldest go first: what the model most needs is what just happened.
    expect(input.related_events_summary.at(-1)!.code).toBe('code-999');
    expect(input.related_events_summary.length).toBeLessThan(1000);
    expect(input.related_events_summary[0]!.code).not.toBe('code-0');
  });

  it('work definition body never appears', () => {
    const input = build({ workDefinitionHash: 'b'.repeat(64) });
    expect(Object.keys(input.work_definition_summary).sort()).toEqual(['hash', 'operation_kinds']);
    expect(JSON.stringify(input)).not.toContain(WORK_DEFINITION_BODY);
    // And there is nowhere to put it: the summary has two keys and neither takes prose.
    expect(input.work_definition_summary.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws when still over limit after truncation', () => {
    const huge = 'x'.repeat(AI_INPUT_LIMIT_BYTES * 2);
    expect(() => build({ registration: { isolation_level: 'standard', note: huge } })).toThrow(AiInputTooLarge);
  });

  /**
   * T-SEC-18. The only public function of the Vertex client takes the summary type.
   *
   * `@ts-expect-error` is the assertion: the lines below fail the build if the parameter
   * ever widens to `unknown`, to `object` or to a string overload.
   */
  it('analyze accepts only SecurityAiInput', () => {
    const accepts: (input: SecurityAiInput) => Promise<string | null> = analyze;
    expect(accepts).toBe(analyze);
    // @ts-expect-error a raw log line is not a summary
    expect(() => analyze('{"log":"line"}')).toBeTypeOf('function');
    // @ts-expect-error nor is an arbitrary object
    expect(() => analyze({ events: [] })).toBeTypeOf('function');
  });
});
