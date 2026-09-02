import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { createLifecycleHarness, recordingClients } from '@xaa/lifecycle-manager/src/testing/harness';
import { requestIdJag, startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { humanSubjectToken } from './harness.js';

const HOUR = 3_600_000;

/**
 * The Agent OP and the Lifecycle Manager over one Firestore, as they are in production.
 *
 * The registration the OP reads and the record the sweep walks are the same document,
 * which is the whole reason expiry needs no message between the two services: the OP
 * refuses on its own `expires_at`, and the sweep destroys on the same field.
 */
async function expiredAgent(options: { statusFor?: Record<string, number> } = {}) {
  const shared = createFirestoreDouble();
  const expiresAt = new Date(Date.now() - HOUR).toISOString();
  const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), shared, expiresAt });
  const clients = recordingClients(options.statusFor ? { statusFor: options.statusFor } : {});
  const harness = createLifecycleHarness({ shared, clients });
  // The Provisioner writes these two; `startAgentOp` seeds only what the OP itself
  // reads, so cleanup's view of the same document is completed here.
  await agentOp.lifecycleStore.update('agents', `${agentOp.agentId}__meta`, {
    job_execution_name: null, bridge_binding_ids: [],
  });
  return { agentOp, harness };
}

const tick = async (harness: Awaited<ReturnType<typeof createLifecycleHarness>>): Promise<Response> =>
  harness.fetch('/internal/tick', { method: 'POST', headers: { Authorization: 'Bearer token' } });

async function exchange(agentOp: AgentOpHarness): Promise<{ status: number; error?: string }> {
  const response = await requestIdJag(agentOp, { subjectToken: await humanSubjectToken() });
  return { status: response.status, ...(await response.json() as { error?: string }) };
}

describe('an expired agent, swept twice', () => {
  /**
   * The second tick is the point. A sweep runs every few minutes and will meet the same
   * agent again — because a step failed, or simply because the first run was still in
   * flight — and it has to be an ordinary, uneventful 200. An error there would mean the
   * scheduler's own retry turns one unreachable dependency into a stuck queue.
   */
  it('second invocation returns 200 and token exchange stays invalid_grant', async () => {
    // The Agent OP is briefly unavailable, so step10 cannot finish and the registration
    // survives both ticks — which is exactly when the retry has to behave.
    const { agentOp, harness } = await expiredAgent({ statusFor: { deleteRegistration: 503 } });

    expect(await exchange(agentOp)).toMatchObject({ status: 400, error: 'invalid_grant' });

    const first = await tick(harness);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ expired: 1 });

    const second = await tick(harness);
    expect(second.status).toBe(200);
    // The second pass finds the agent REVOKED with a failed step and retries it; it is
    // not an error, and it is not counted as a fresh expiry either.
    expect(await second.json()).toMatchObject({ expired: 0, retried: 1 });

    expect(await exchange(agentOp)).toMatchObject({ status: 400, error: 'invalid_grant' });
    const meta = await harness.documents.get<{ status: string }>('agents', `${agentOp.agentId}__meta`);
    expect(meta!.status).toBe('REVOKED');
  });

  it('removes the registration entirely once every step succeeds', async () => {
    const { agentOp, harness } = await expiredAgent();

    expect((await tick(harness)).status).toBe(200);
    expect(await harness.documents.get('agents', `${agentOp.agentId}__meta`)).toBeUndefined();

    // With nothing left to sweep the next tick is a no-op, and the exchange cannot
    // succeed because there is no agent to authenticate as any more.
    const second = await tick(harness);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ scanned: 0, expired: 0, retried: 0 });
    expect((await exchange(agentOp)).status).not.toBe(200);
  });
});
