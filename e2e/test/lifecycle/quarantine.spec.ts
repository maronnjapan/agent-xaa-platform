import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createLifecycleHarness, recordingClients } from '@xaa/lifecycle-manager/src/testing/harness';
import { requestIdJag, startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';
import { idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { connectHuman, requestSubjectToken } from './harness.js';

const HOUR = 3_600_000;

/**
 * A quarantine, from the request Security Detection makes to what the agent can still do.
 *
 * The point of the state is that it is narrow: the agent's identity stops working while
 * the agent itself keeps running. Both halves are asserted here, because either one on
 * its own would be satisfied by the wrong implementation — cancelling the execution
 * would also stop the tokens, and doing nothing would also leave the checkpoint writable.
 */
async function quarantinableAgent() {
  const shared = createFirestoreDouble();
  const idp = await startHumanIdp();
  const idpFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    idp.fetch(new URL(String(input)).pathname, init)) as unknown as typeof fetch;
  const connection = await connectHuman(idp);
  const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), shared, humanIdpFetch: idpFetch });

  const connectionId = `idpconn-${agentOp.agentId}`;
  await agentOp.documents.set('idp_connections', connectionId, {
    idp_connection_id: connectionId,
    agent_id: agentOp.agentId,
    human_subject: 'testuser',
    encrypted_refresh_token: Buffer.from(`${agentOp.agentId}::${connection.refreshToken}`, 'utf8').toString('base64'),
    granted_scopes: ['openid', 'offline_access'],
    status: 'ACTIVE',
    created_at: new Date(Date.now() - HOUR).toISOString(),
    expires_at: new Date(Date.now() + HOUR).toISOString(),
  });
  await agentOp.lifecycleStore.update('agents', `${agentOp.agentId}__meta`, {
    job_execution_name: 'projects/p/locations/l/jobs/agent-runtime-standard/executions/exec-1',
    bridge_binding_ids: ['bind-1'],
  });

  const clients = recordingClients({ bridgeUrl: 'https://bridge.test' });
  const lifecycle = createLifecycleHarness({ shared, clients });
  const runtimeStore = createFirestoreDocumentStore(shared, 'agent-runtime');
  return { agentOp, lifecycle, clients, runtimeStore, connectionId, subjectToken: connection.idToken };
}

const transition = (
  lifecycle: ReturnType<typeof createLifecycleHarness>, agentOp: AgentOpHarness, body: Record<string, unknown>,
): Promise<Response> => lifecycle.fetch(`/internal/agents/${agentOp.agentId}/transition`, {
  method: 'POST',
  headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('an agent placed in quarantine', () => {
  it('token exchange and subject-token both fail right after quarantine', async () => {
    const { agentOp, lifecycle, runtimeStore, connectionId, subjectToken } = await quarantinableAgent();

    // The agent is healthy: it can still exchange its subject token for an ID-JAG.
    expect((await requestIdJag(agentOp, { subjectToken })).status).toBe(200);

    const moved = await transition(lifecycle, agentOp, {
      to: 'QUARANTINED', severity: 'CRITICAL', reason: 'QUARANTINE',
    });
    expect(moved.status).toBe(202);
    expect(await moved.json()).toMatchObject({ to: 'QUARANTINED' });

    // Immediately, with no sweep and no second call: the OP reads the same record.
    const exchange = await requestIdJag(agentOp, { subjectToken });
    expect(exchange.status).toBe(400);
    expect(await exchange.json()).toMatchObject({ error: 'invalid_grant' });

    const subject = await requestSubjectToken(agentOp);
    expect(subject.status).toBe(400);
    expect(await subject.json()).toMatchObject({ error: 'invalid_grant' });

    // The refusal is the agent's status and nothing else: the connection row was left
    // ACTIVE, so re-obtaining a subject token is blocked by what the agent now is,
    // not by anything having been taken away from it.
    expect(await agentOp.documents.get<{ status: string }>('idp_connections', connectionId))
      .toMatchObject({ status: 'ACTIVE' });

    // And the agent is still running, still writing what it is doing. That is the
    // reason quarantine exists as a state of its own: evidence, not mercy.
    await expect(runtimeStore.set('agents', `${agentOp.agentId}__state`, {
      agent_status: 'RUNNING', step: 'writing a checkpoint after the quarantine',
    })).resolves.toBeUndefined();
    expect(await runtimeStore.get<{ step: string }>('agents', `${agentOp.agentId}__state`))
      .toMatchObject({ step: 'writing a checkpoint after the quarantine' });
  });

  it('never cancels the execution until the agent is revoked', async () => {
    const { agentOp, lifecycle, clients } = await quarantinableAgent();

    expect((await transition(lifecycle, agentOp, { to: 'QUARANTINED', severity: 'CRITICAL', reason: 'QUARANTINE' })).status)
      .toBe(202);
    expect(clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(0);
    expect(clients.calls.map((entry) => entry.target)).toEqual(['disableIssuance', 'disableBindings']);

    expect((await transition(lifecycle, agentOp, { to: 'REVOKED', reason: 'QUARANTINE' })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(1);
  });
});
