import { describe, expect, it } from 'vitest';
import { CALLER_TOKEN, createSecurityHarness, AGENT_ID } from '../src/testing/harness.js';
import type { StoredFinding } from '../src/index.js';

async function seedPending(harness: ReturnType<typeof createSecurityHarness>, overrides: Partial<StoredFinding> = {}): Promise<string> {
  const finding: StoredFinding = {
    finding_id: 'f_1_abcdef01', finding_type: 'potential_agent_compromise', agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
    related_events: [], contributing_codes: [], risk_score: 85, risk_level: 'CRITICAL',
    review_status: 'pending', created_at: '2026-01-01T12:10:00.000Z',
    recommended_response: 'QUARANTINED', confidence: 0.5, ...overrides,
  };
  await harness.documents.set('security_findings', finding.finding_id, finding as unknown as Record<string, unknown>);
  return finding.finding_id;
}

const review = (harness: ReturnType<typeof createSecurityHarness>, id: string, body: unknown, token = CALLER_TOKEN) =>
  harness.fetch(`/internal/review/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

/**
 * REQ-09 human review. What a person is asked to confirm, and what happens when they do.
 */
describe('human review', () => {
  it('does nothing to the agent while the decision is pending', async () => {
    const harness = createSecurityHarness();
    await seedPending(harness);
    expect(harness.transitions).toHaveLength(0);
  });

  it('asks the Lifecycle Manager exactly once on approval', async () => {
    const harness = createSecurityHarness();
    const id = await seedPending(harness);
    const response = await review(harness, id, { decision: 'approve', reviewer: 'operator@example.test' });
    expect(response.status).toBe(200);
    expect(harness.transitions).toHaveLength(1);
    expect(harness.transitions[0]).toMatchObject({
      agent_id: AGENT_ID, to: 'QUARANTINED', finding_id: id,
      // The finding's own type, never free text.
      reason_code: 'potential_agent_compromise',
    });
    const stored = await harness.documents.get<StoredFinding>('security_findings', id);
    expect(stored!.review_status).toBe('approved');
  });

  it('records a rejection and calls nothing', async () => {
    const harness = createSecurityHarness();
    const id = await seedPending(harness);
    expect((await review(harness, id, { decision: 'reject', reviewer: 'operator@example.test' })).status).toBe(200);
    expect(harness.transitions).toHaveLength(0);
    expect((await harness.documents.get<StoredFinding>('security_findings', id))!.review_status).toBe('rejected');
  });

  it('refuses a second decision on the same finding', async () => {
    const harness = createSecurityHarness();
    const id = await seedPending(harness);
    await review(harness, id, { decision: 'approve', reviewer: 'a' });
    const second = await review(harness, id, { decision: 'reject', reviewer: 'b' });
    expect(second.status).toBe(409);
    // The first decision stands; the second does not overwrite the record of it.
    expect((await harness.documents.get<StoredFinding>('security_findings', id))!.review_status).toBe('approved');
    expect(harness.transitions).toHaveLength(1);
  });

  it('refuses a malformed decision and an unknown finding', async () => {
    const harness = createSecurityHarness();
    const id = await seedPending(harness);
    expect((await review(harness, id, { decision: 'maybe', reviewer: 'a' })).status).toBe(400);
    expect((await review(harness, id, { decision: 'approve' })).status).toBe(400);
    expect((await review(harness, 'f_missing', { decision: 'approve', reviewer: 'a' })).status).toBe(404);
  });
});
