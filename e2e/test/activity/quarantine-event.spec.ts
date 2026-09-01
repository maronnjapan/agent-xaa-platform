import { describe, expect, it } from 'vitest';
import { createSecurityHarness, baselineFor, logEntry, AGENT_ID, CALLER_TOKEN } from '@xaa/security-detection/src/testing/harness';
import type { ActivityEvent } from '@xaa/contracts';

/**
 * RULE-55. A quarantine is the one security decision a person sees on their own
 * timeline, because it is the one that stops their agent. Everything else the detector
 * concludes stays in the security stream.
 *
 * The batch below is what the platform's own services would have logged: the Agent OP
 * refusing a token exchange whose delegation did not match. That single verdict scores
 * CRITICAL on its own, which is what drives the transition.
 */
function forgedDelegation() {
  return [{
    jsonPayload: logEntry({
      severity: 'WARNING',
      fields: { validation: 'human_subject_mismatch' },
    }),
  }];
}

/**
 * A quarantine is never automatic: the recommendation always waits for a person
 * (T-SEC-35), and the event exists to tell the agent's owner what that person decided.
 * So the run below stops at a pending finding, and the approval is what moves it.
 */
async function quarantineApproved(options: { transitionStatus?: number } = {}) {
  const harness = createSecurityHarness({
    ...options,
    // A confident recommendation, as the model would return one.
    aiOutput: JSON.stringify({
      deviation: { from_normal: 'delegation forged', capability_consistency: 'inconsistent' },
      judgement: { compromise_likelihood: 'high', false_positive_likelihood: 'low', causality: 'clear' },
      impact: { scope: 'one agent', op_propagation: 'none' },
      recommendation: { response: 'QUARANTINED', confidence: 0.95 },
    }),
  });
  await harness.seedStore.set('agents', `${AGENT_ID}__baseline`, baselineFor() as never);
  await harness.runOnce(forgedDelegation());

  const pending = await harness.documents.listAll<{ review_status?: string }>('security_findings');
  expect(pending).toHaveLength(1);
  expect(pending[0]!.data.review_status).toBe('pending');

  const approved = await harness.fetch(`/internal/review/${encodeURIComponent(pending[0]!.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${CALLER_TOKEN}` },
    body: JSON.stringify({ decision: 'approve', reviewer: 'operator-1' }),
  });
  expect(approved.status).toBe(200);
  return { harness, findingId: pending[0]!.id };
}

function quarantineEvents(activity: ActivityEvent[]): ActivityEvent[] {
  return activity.filter((event) =>
    (event.detail as { event_type?: string } | undefined)?.event_type === 'AGENT_QUARANTINED');
}

describe('a quarantine reaches the person whose agent it was', () => {
  it('critical finding emits one quarantine event', async () => {
    const { harness } = await quarantineApproved();

    expect(harness.transitions.map((request) => request.to)).toContain('QUARANTINED');
    const events = quarantineEvents(harness.activity);
    expect(events).toHaveLength(1);
    expect(events[0]!.agent_id).toBe(AGENT_ID);
    expect(events[0]!.phase).toBe('security');
    expect(events[0]!.outcome).toBe('blocked');
  });

  it('related_finding_id is not null', async () => {
    const { harness, findingId } = await quarantineApproved();

    const [event] = quarantineEvents(harness.activity);
    expect(event!.related_finding_id).toBe(findingId);
  });

  it('payload contains no jwt like string', async () => {
    const { harness } = await quarantineApproved();

    const [event] = quarantineEvents(harness.activity);
    expect(JSON.stringify(event)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('no event when transition request fails', async () => {
    const { harness } = await quarantineApproved({ transitionStatus: 502 });

    // The agent may still be running, so telling the person it was isolated would be
    // a false statement on the record.
    expect(quarantineEvents(harness.activity)).toHaveLength(0);
  });
});
