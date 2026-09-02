import { describe, expect, it } from 'vitest';
import {
  AGENT_ID, CALLER_TOKEN, createSecurityHarness, type SecurityHarness,
} from '@xaa/security-detection/src/testing/harness';
import type { StoredFinding } from '@xaa/security-detection/src/index';
import { readFile } from 'node:fs/promises';

const FINDING_ID = 'f_1767268800_abcdef01';

/** An AI answer the platform is not willing to act on unaided. */
function aiOutput(confidence: number, response = 'QUARANTINED'): string {
  return JSON.stringify({
    deviation: { from_normal: 'a', capability_consistency: 'b' },
    judgement: { compromise_likelihood: 'a', false_positive_likelihood: 'b', causality: 'c' },
    impact: { scope: 'a', op_propagation: 'b' },
    recommendation: { response, confidence },
  });
}

async function seedPending(harness: SecurityHarness, overrides: Partial<StoredFinding> = {}): Promise<string> {
  const finding: StoredFinding = {
    finding_id: FINDING_ID, finding_type: 'potential_agent_compromise', agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
    related_events: [], contributing_codes: ['isolation.dedicated_op_mismatch'],
    risk_score: 85, risk_level: 'CRITICAL', review_status: 'pending',
    created_at: '2026-01-01T12:10:00.000Z', recommended_response: 'QUARANTINED', confidence: 0.5,
    ...overrides,
  };
  await harness.documents.set('security_findings', finding.finding_id, finding as unknown as Record<string, unknown>);
  return finding.finding_id;
}

/** Exactly the request `scripts/review-finding.ts` sends, and nothing else. */
async function decide(harness: SecurityHarness, id: string, decision: string, reviewer = 'operator@example.test') {
  const response = await harness.fetch(`/internal/review/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${CALLER_TOKEN}` },
    body: JSON.stringify({ decision, reviewer }),
  });
  return response.status;
}

async function statusOf(harness: SecurityHarness, id: string): Promise<string> {
  return (await harness.documents.get<StoredFinding>('security_findings', id))!.review_status;
}

/**
 * T-SEC-35 / REQ-09-050. A person stands between the model and the agent.
 *
 * Two conditions send a finding to review: the model was not confident, or what it
 * recommends would stop the agent. Both are cases where being wrong is expensive — a
 * quarantine ends someone's automation — so the platform records what it would do and
 * waits, and the CLI below is the whole of the interface for saying yes.
 */
describe('human review of a Security Finding', () => {
  it('confidence 0.5 stays pending', async () => {
    const harness = createSecurityHarness({ aiOutput: aiOutput(0.5, 'ACTIVE') });
    const id = await seedPending(harness, { recommended_response: 'ACTIVE', confidence: 0.5 });

    expect(await statusOf(harness, id)).toBe('pending');
    // The Lifecycle Manager has not been asked for anything.
    expect(harness.transitions).toHaveLength(0);
    expect(harness.activity).toHaveLength(0);
  });

  it('approve calls lifecycle once', async () => {
    const harness = createSecurityHarness();
    const id = await seedPending(harness);

    expect(await decide(harness, id, 'approve')).toBe(200);

    expect(harness.transitions).toHaveLength(1);
    expect(harness.transitions[0]).toMatchObject({
      agent_id: AGENT_ID, to: 'QUARANTINED', finding_id: id,
      // The finding's own type, never free text.
      reason_code: 'potential_agent_compromise',
    });
    expect(await statusOf(harness, id)).toBe('approved');
  });

  it('reject sets rejected and calls nothing', async () => {
    const harness = createSecurityHarness();
    const id = await seedPending(harness);

    expect(await decide(harness, id, 'reject')).toBe(200);

    expect(await statusOf(harness, id)).toBe('rejected');
    expect(harness.transitions).toHaveLength(0);
    expect(harness.activity).toHaveLength(0);
  });

  it('second decision returns 409', async () => {
    const harness = createSecurityHarness();
    const id = await seedPending(harness);
    expect(await decide(harness, id, 'approve', 'first@example.test')).toBe(200);

    expect(await decide(harness, id, 'reject', 'second@example.test')).toBe(409);

    // The first decision stands, and it was acted on exactly once.
    expect(await statusOf(harness, id)).toBe('approved');
    expect(harness.transitions).toHaveLength(1);
  });

  it('the CLI takes two arguments and touches no store directly', async () => {
    const source = await readFile(new URL('../../../scripts/review-finding.ts', import.meta.url), 'utf8');
    expect(source).toContain('usage: review-finding.ts <finding_id> approve|reject');
    expect(source).toContain('argv.length !== 2');
    expect(source).toContain('/internal/review/');
    // A decision written straight into the datastore would skip the transition request
    // the endpoint makes, leaving an approved finding and a still-working agent. So the
    // script imports no store client at all.
    expect(source).not.toMatch(/@google-cloud\/(firestore|bigquery)/);
    expect(FINDING_ID).toMatch(/^f_\d+_[0-9a-f]{8}$/);
  });
});
