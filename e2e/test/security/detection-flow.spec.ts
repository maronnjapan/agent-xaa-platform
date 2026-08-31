import { describe, expect, it } from 'vitest';
import { createFirestoreDouble, createFirestoreDocumentStore } from '@xaa/gcp';
import { normalizeEntries } from '@xaa/security-detection/src/normalize/index';
import { detectRuleHits } from '@xaa/security-detection/src/rules/index';
import { correlate } from '@xaa/security-detection/src/correlate/index';
import { computeScore } from '@xaa/security-detection/src/score/compute';
import { toLevel } from '@xaa/security-detection/src/score/level';
import { buildBaseline } from '@xaa/security-detection/src/baseline/build';
import { writeAgentBaseline } from '@xaa/provisioner/src/baseline-hook';
import type { LogEntry } from '@xaa/logging';

const AGENT_A = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
const AGENT_B = 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    severity: 'WARNING', app: 'agent-op', log_source: 'agent_op', event: 'protocol_validation',
    request_id: 'req', trace_id: 'trace-1', agent_id: AGENT_A, human_subject: 'testuser',
    timestamp: '2026-01-01T12:00:00.000Z', fields: {}, ...overrides,
  };
}

/**
 * The detection pipeline over evidence the platform's own services would have logged.
 *
 * Nothing here decides whether a violation happened — the services already did, at the
 * moment of the request (DEC-SEC-02). What is exercised is what the platform makes of
 * those verdicts once they are side by side: which of them add up to a finding, how
 * severe it is, and what the blast radius looks like.
 */
describe('the detection pipeline, end to end', () => {
  it('turns one forged delegation into a CRITICAL finding on its own', () => {
    const events = normalizeEntries([entry({ fields: { validation: 'human_subject_mismatch' } })]);
    const hits = detectRuleHits({
      events: events.events,
      violations: [{
        code: 'human_subject_mismatch', agent_id: AGENT_A, human_subject: 'testuser',
        occurred_at: '2026-01-01T12:00:00.000Z', trace_id: 'trace-1', event: events.events[0]!,
      }],
      baselines: new Map([[AGENT_A, buildBaseline({
        effectiveCapabilities: ['document.read'], expectedTools: ['internal.document.list'],
        expectedResources: [], expiresAt: '2026-01-02T00:00:00.000Z',
      })]]),
    });
    const findings = correlate({ hits: hits.hits, violations: [] });
    expect(findings).toHaveLength(1);
    const score = computeScore({ finding: findings[0]! });
    // No accumulation needed: a delegation that does not match is critical by itself.
    expect(score).toBe(100);
    expect(toLevel(score)).toBe('CRITICAL');
  });

  it('reports two agents reaching each other as one lateral movement, not two anomalies', () => {
    const events = normalizeEntries([
      entry({ agent_id: AGENT_A, fields: { validation: 'cross_agent_access', op_agent_id: AGENT_B } }),
      entry({ agent_id: AGENT_B, trace_id: 'trace-2', fields: { validation: 'cross_agent_access', op_agent_id: AGENT_A } }),
    ]);
    const violations = events.events.map((event) => ({
      code: 'cross_agent_access', agent_id: event.actor.agent_id, human_subject: event.actor.human_subject,
      occurred_at: event.time, trace_id: event.metadata.trace_id, event,
    }));
    const hits = detectRuleHits({ events: [], violations, baselines: new Map() });
    const findings = correlate({ hits: hits.hits, violations: [] });
    const lateral = findings.filter((finding) => finding.finding_type === 'cross_agent_lateral_movement');
    expect(lateral).toHaveLength(1);
    // One incident, described once, rather than the same event told from both ends.
    expect(findings).toHaveLength(1);
  });

  it('leaves an ordinary agent alone', () => {
    const events = normalizeEntries([entry({ severity: 'INFO', fields: { result: 'issued' } })]);
    const hits = detectRuleHits({
      events: events.events, violations: [],
      baselines: new Map([[AGENT_A, buildBaseline({
        effectiveCapabilities: ['document.read'], expectedTools: ['internal.document.list'],
        expectedResources: [], expiresAt: '2026-01-02T00:00:00.000Z',
      })]]),
    });
    expect(hits.hits).toHaveLength(0);
    expect(correlate({ hits: hits.hits, violations: [] })).toEqual([]);
  });

  it('has a baseline the moment provisioning finishes, and none before', async () => {
    const shared = createFirestoreDouble();
    const provisioner = createFirestoreDocumentStore(shared, 'provisioner');
    const detector = createFirestoreDocumentStore(shared, 'security-detection');

    expect(await detector.get('agents', `${AGENT_A}__baseline`)).toBeUndefined();

    await writeAgentBaseline({
      documents: provisioner, agentId: AGENT_A,
      baseline: buildBaseline({
        effectiveCapabilities: ['document.read'],
        expectedTools: ['internal.document.list', 'internal.document.get'],
        expectedResources: ['https://resource-docs-api.test'],
        expiresAt: '2026-01-02T00:00:00.000Z',
      }),
    });

    const stored = await detector.get<{ expected_tools: string[]; expected_rate: { api_request: { max: number } } }>(
      'agents', `${AGENT_A}__baseline`,
    );
    expect(stored!.expected_tools).toEqual(['internal.document.list', 'internal.document.get']);
    expect(stored!.expected_rate.api_request.max).toBe(100);
  });
});
