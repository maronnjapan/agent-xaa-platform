import { describe, expect, it } from 'vitest';
import { createLifecycleHarness, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';

const FINDING_ID = 'f_1767268800_abcdef01';

function transition(harness: LifecycleHarness, agentId: string, body: Record<string, unknown>) {
  return harness.fetch(`/internal/agents/${agentId}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer caller' },
    body: JSON.stringify(body),
  });
}

/** What Security Detection sends when a CRITICAL finding is approved (T-SEC-34). */
const quarantineRequest = { to: 'QUARANTINED', reason: 'QUARANTINE', severity: 'CRITICAL' };

async function statusOf(harness: LifecycleHarness, agentId: string): Promise<string> {
  const meta = await harness.documents.get<{ status: string }>('agents', `${agentId}__meta`);
  return meta!.status;
}

/**
 * T-SEC-34. The only thing Security Detection is allowed to do to an agent.
 *
 * The detector asks; this service decides and acts. Two properties matter here: the same
 * finding arriving twice must not walk the agent two rungs down the ladder, and a
 * quarantine must actually stop the Agent OP issuing rather than only recording a word
 * in Firestore.
 */
describe('the internal security transition', () => {
  it('same finding twice advances once', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);

    const first = await transition(harness, agentId, quarantineRequest);
    expect(first.status).toBe(202);
    expect(await statusOf(harness, agentId)).toBe('QUARANTINED');

    // The retry a redelivered Pub/Sub message or an impatient reviewer produces.
    const second = await transition(harness, agentId, quarantineRequest);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'invalid_transition' });

    expect(await statusOf(harness, agentId)).toBe('QUARANTINED');
    // And the OP was told once, not twice: a second disableIssuance would be harmless
    // here and misleading in the audit trail.
    expect(harness.clients.calls.filter((call) => call.target === 'disableIssuance')).toHaveLength(1);
  });

  it('quarantine stops id-jag issuance', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);

    expect((await transition(harness, agentId, quarantineRequest)).status).toBe(202);

    // Two halves of the same stop: the Agent OP is told, and the registration the OP
    // reads on every `/xaa/token` no longer says ACTIVE — which is what makes the
    // exchange answer `invalid_grant` (e2e/test/security/quarantine.spec.ts).
    expect(harness.clients.calls).toContainEqual({ target: 'disableIssuance', argument: agentId });
    expect(await statusOf(harness, agentId)).toBe('QUARANTINED');
  });

  it('refuses ACTIVE straight to QUARANTINED without a CRITICAL severity', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    const response = await transition(harness, agentId, { to: 'QUARANTINED', reason: 'QUARANTINE' });
    expect(response.status).toBe(409);
    expect(await statusOf(harness, agentId)).toBe('ACTIVE');
  });

  it('refuses a caller that is not on the list', async () => {
    const harness = createLifecycleHarness({ callerEmail: 'sa-runtime@xaa-test.iam.gserviceaccount.com' });
    const agentId = await seedDomain(harness);
    const response = await transition(harness, agentId, quarantineRequest);
    expect(response.status).toBe(403);
    expect(await statusOf(harness, agentId)).toBe('ACTIVE');
    expect(FINDING_ID).toMatch(/^f_\d+_[0-9a-f]{8}$/);
  });
});
