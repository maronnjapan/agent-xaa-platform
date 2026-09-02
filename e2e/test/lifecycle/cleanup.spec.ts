import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { cleanupAgent } from '@xaa/lifecycle-manager/src/cleanup/index';
import { DOMAIN_SUBDOCUMENTS } from '@xaa/lifecycle-manager/src/domain';
import { createLifecycleHarness, recordingClients } from '@xaa/lifecycle-manager/src/testing/harness';
import { startAgentOp } from '../../harness/agent-op.js';
import { idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { connectHuman, requestSubjectToken } from './harness.js';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };
const LIFECYCLE_SA = 'sa-lifecycle@xaa-test.iam.gserviceaccount.com';
const HOUR = 3_600_000;

/**
 * Everything an agent leaves behind, and cleanup run once over all of it.
 *
 * The Agent OP's registration and its IdP connection are real documents written by the
 * real service; the Bridge is not deployed in the default profile (DEC-SCOPE-04), so
 * its two calls are answered by doubles that do what T-BRIDGE-08 and T-BRIDGE-18
 * specify — disable, then delete the agent's binding rows.
 */
async function agentWithEverything() {
  const shared = createFirestoreDouble();
  const idp = await startHumanIdp();
  const idpFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    idp.fetch(new URL(String(input)).pathname, init)) as unknown as typeof fetch;
  const connection = await connectHuman(idp);
  const agentOp = await startAgentOp({
    idpPublicJwk: await idpPublicJwk(), shared, humanIdpFetch: idpFetch,
    internalCallers: {
      lifecycle: LIFECYCLE_SA,
      verify: async (authorization) => (authorization === `Bearer ${LIFECYCLE_SA}` ? LIFECYCLE_SA : null),
    },
  });
  const agentId = agentOp.agentId;

  const connectionId = `idpconn-${agentId}`;
  await agentOp.documents.set('idp_connections', connectionId, {
    idp_connection_id: connectionId, agent_id: agentId, human_subject: 'testuser',
    encrypted_refresh_token: Buffer.from(`${agentId}::${connection.refreshToken}`, 'utf8').toString('base64'),
    granted_scopes: ['openid', 'offline_access'], status: 'ACTIVE',
    created_at: new Date(Date.now() - HOUR).toISOString(),
    expires_at: new Date(Date.now() + HOUR).toISOString(),
  });
  await agentOp.lifecycleStore.update('agents', `${agentId}__meta`, {
    job_execution_name: 'projects/p/locations/l/jobs/agent-runtime-standard/executions/exec-1',
    bridge_binding_ids: ['bind-1'],
  });

  // What the Runtime and the Provisioner wrote about this agent.
  const runtimeStore = createFirestoreDocumentStore(shared, 'agent-runtime');
  const provisionerStore = createFirestoreDocumentStore(shared, 'provisioner');
  await runtimeStore.set('agents', `${agentId}__state`, { agent_status: 'RUNNING' });
  await runtimeStore.set('agent_instructions', 'ins-1', { agent_id: agentId, text: 'keep going', applied_at: null });
  await provisionerStore.set('agents', `${agentId}__manifest`, { tools: [] });

  const clients = recordingClients({ bridgeUrl: 'https://bridge.test' });
  const lifecycle = createLifecycleHarness({ shared, clients });
  const bindingStore = createFirestoreDocumentStore(shared, 'google-bridge');
  await bindingStore.set('agent_bindings', 'bind-1', { agent_id: agentId, status: 'ACTIVE' });

  clients.agentOp.revokeIdpConnection = async ({ agentId: id }) => (await agentOp.fetch('/internal/revoke-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LIFECYCLE_SA}` },
    body: JSON.stringify({ agent_id: id }),
  })).status;
  clients.bridge.disableBindings = async ({ agentId: id }) => {
    await bindingStore.update('agent_bindings', 'bind-1', { status: 'DISABLED', agent_id: id });
    return 200;
  };
  clients.bridge.deleteBindings = async () => {
    await bindingStore.delete('agent_bindings', 'bind-1');
    return 200;
  };

  return { agentOp, agentId, lifecycle, clients, runtimeStore, bindingStore, connectionId };
}

describe('after cleanup has finished', () => {
  it('registration, idp connection, bridge binding and runtime state are all gone', async () => {
    const { agentOp, agentId, lifecycle, runtimeStore, bindingStore, connectionId } = await agentWithEverything();

    const outcome = await cleanupAgent(agentId, 'USER_STOP', {
      documents: lifecycle.documents, clients: lifecycle.clients, logger, logContext,
    });
    expect(outcome.status).toBe('DESTROYED');

    // The registration the Agent OP reads: gone, along with every other document under
    // agents/{agent_id}.
    const left = await Promise.all(DOMAIN_SUBDOCUMENTS.map((part) => lifecycle.documents.get('agents', `${agentId}__${part}`)));
    expect(left.filter((document) => document !== undefined)).toHaveLength(0);

    // The runtime state and the instructions nobody will read now.
    expect(await runtimeStore.get('agents', `${agentId}__state`)).toBeUndefined();
    expect(await runtimeStore.queryEqual('agent_instructions', [['agent_id', agentId]])).toEqual([]);

    // The Bridge binding row.
    expect(await bindingStore.get('agent_bindings', 'bind-1')).toBeUndefined();

    // The IdP connection is unusable. The row itself stays on purpose — it is the audit
    // record of a credential that once existed — with its status saying so.
    expect(await agentOp.documents.get<{ status: string }>('idp_connections', connectionId))
      .toMatchObject({ status: 'REVOKED' });
    // And there is nothing left to ask with: the registration carrying the agent's
    // public key is gone, so its client assertion no longer authenticates at all.
    const subject = await requestSubjectToken(agentOp);
    expect(subject.status).toBe(401);
    expect(await subject.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('is safe to run twice over the same agent', async () => {
    const { agentId, lifecycle, clients } = await agentWithEverything();
    const deps = { documents: lifecycle.documents, clients, logger, logContext };

    expect((await cleanupAgent(agentId, 'USER_STOP', deps)).status).toBe('DESTROYED');
    const before = clients.calls.length;
    // The record is gone, so the second run has nothing to claim and does nothing: no
    // step runs, no call is made, and no exception escapes to the sweep that called it.
    const again = await cleanupAgent(agentId, 'USER_STOP', deps);
    expect(again.results).toEqual([]);
    expect(clients.calls).toHaveLength(before);
  });
});
