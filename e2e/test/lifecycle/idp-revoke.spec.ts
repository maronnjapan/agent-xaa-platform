import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { cleanupAgent } from '@xaa/lifecycle-manager/src/cleanup/index';
import { createLifecycleHarness, recordingClients } from '@xaa/lifecycle-manager/src/testing/harness';
import { startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { connectHuman, PLATFORM_CLIENT } from './harness.js';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };
const LIFECYCLE_SA = 'sa-lifecycle@xaa-test.iam.gserviceaccount.com';
const HOUR = 3_600_000;

/**
 * Three services in one process: Human IdP, Agent OP and Lifecycle Manager.
 *
 * The wiring matters more than usual here. `sa-lifecycle` deliberately holds no
 * permission on the connection-encryption key (DEC-IAC-08), so the refresh token is
 * decrypted inside the Agent OP and spent against the real Human IdP `/revoke`. Faking
 * the OP's side would leave the one property the test exists for — that a revoke
 * reaches the IdP's own token store and touches nothing else — unproven.
 */
async function startOp(shared: ReturnType<typeof createFirestoreDouble>, humanIdpFetch: typeof fetch, agentId?: string): Promise<AgentOpHarness> {
  return startAgentOp({
    idpPublicJwk: await idpPublicJwk(),
    shared,
    humanIdpFetch,
    ...(agentId ? { agentId } : {}),
    internalCallers: {
      lifecycle: LIFECYCLE_SA,
      verify: async (authorization) => (authorization === `Bearer ${LIFECYCLE_SA}` ? LIFECYCLE_SA : null),
    },
  });
}

/** The stored connection, in the shape the Agent OP's callback writes it. */
async function seedConnection(agentOp: AgentOpHarness, refreshToken: string): Promise<string> {
  const connectionId = `idpconn-${agentOp.agentId}`;
  await agentOp.documents.set('idp_connections', connectionId, {
    idp_connection_id: connectionId,
    agent_id: agentOp.agentId,
    human_subject: 'testuser',
    // The harness envelope is `aad::plaintext`, base64 — the same shape the callback
    // stores, so the OP's own decrypt is what produces the token it sends.
    encrypted_refresh_token: Buffer.from(`${agentOp.agentId}::${refreshToken}`, 'utf8').toString('base64'),
    granted_scopes: ['openid', 'offline_access'],
    status: 'ACTIVE',
    created_at: new Date(Date.now() - HOUR).toISOString(),
    expires_at: new Date(Date.now() + HOUR).toISOString(),
  });
  return connectionId;
}

describe('revoking one agent connection', () => {
  it('revoking agent A keeps agent B connection and the SSO session', async () => {
    const idp = await startHumanIdp();
    const idpFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      idp.fetch(new URL(String(input)).pathname, init)) as unknown as typeof fetch;

    // Two agents for the same person, connected through the same browser session.
    const agentA = await connectHuman(idp);
    const agentB = await connectHuman(idp, agentA.cookie);
    expect(agentB.refreshToken).toBeDefined();

    const shared = createFirestoreDouble();
    const opA = await startOp(shared, idpFetch);
    const connectionA = await seedConnection(opA, agentA.refreshToken);
    await opA.lifecycleStore.update('agents', `${opA.agentId}__meta`, {
      job_execution_name: null, bridge_binding_ids: [], expires_at: new Date(Date.now() - HOUR).toISOString(),
    });

    // The Lifecycle Manager's step3 client, pointed at the Agent OP running beside it.
    const clients = recordingClients();
    clients.agentOp.revokeIdpConnection = async ({ agentId, connectionId }) => {
      clients.calls.push({ target: 'revokeIdpConnection', argument: connectionId });
      return (await opA.fetch('/internal/revoke-connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${LIFECYCLE_SA}` },
        body: JSON.stringify({ agent_id: agentId }),
      })).status;
    };
    const lifecycle = createLifecycleHarness({ shared, clients });

    const outcome = await cleanupAgent(opA.agentId, 'USER_STOP', {
      documents: lifecycle.documents, clients, logger, logContext,
    });
    expect(outcome.status).toBe('DESTROYED');

    // A's connection is closed on this side: the row survives for the audit, marked
    // REVOKED, and the OP was the one that spent the token — the Lifecycle Manager only
    // named the agent.
    const closed = await opA.documents.get<{ status: string; encrypted_refresh_token?: unknown }>('idp_connections', connectionA);
    expect(closed!.status).toBe('REVOKED');
    // Human IdP accepted the token back, so the OP dropped the ciphertext: a REVOKED row
    // that still carried it would be a credential nobody can use but anybody could find.
    expect(closed!.encrypted_refresh_token).toBeUndefined();

    // A's refresh token is dead at the IdP itself, not only marked so on this side.
    const refreshA = await tokenRequest({
      fetch: idp.fetch, ...PLATFORM_CLIENT, issuer: HUMAN_IDP_ISSUER,
      form: { grant_type: 'refresh_token', refresh_token: agentA.refreshToken, client_id: PLATFORM_CLIENT.clientId },
    });
    expect(refreshA.status).toBe(400);
    expect((await refreshA.json() as { error: string }).error).toBe('invalid_grant');

    // B's is untouched: one connection was named, not the person.
    const refreshB = await tokenRequest({
      fetch: idp.fetch, ...PLATFORM_CLIENT, issuer: HUMAN_IDP_ISSUER,
      form: { grant_type: 'refresh_token', refresh_token: agentB.refreshToken, client_id: PLATFORM_CLIENT.clientId },
    });
    expect(refreshB.status).toBe(200);

    // And the person is still logged in: `prompt=none` returns a code rather than
    // sending them back to a login screen.
    const silent = await authorize({
      fetch: idp.fetch, clientId: PLATFORM_CLIENT.clientId, redirectUri: AGENT_OP_CALLBACK_URI,
      scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'none', cookie: agentA.cookie!,
    });
    expect(silent.error).toBeUndefined();
    expect(silent.code).toBeDefined();

    // Exactly one connection was asked about — never the person's other agents.
    expect(clients.calls.filter((entry) => entry.target === 'revokeIdpConnection')).toHaveLength(1);
    expect(clients.calls.filter((entry) => entry.target === 'revokeIdpConnection')[0]!.argument)
      .toBe(connectionA);
  });

  it('never sends the refresh token back to the lifecycle manager', async () => {
    const idp = await startHumanIdp();
    const idpFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      idp.fetch(new URL(String(input)).pathname, init)) as unknown as typeof fetch;
    const connection = await connectHuman(idp);

    const shared = createFirestoreDouble();
    const op = await startOp(shared, idpFetch);
    await seedConnection(op, connection.refreshToken);

    const response = await op.fetch('/internal/revoke-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${LIFECYCLE_SA}` },
      body: JSON.stringify({ agent_id: op.agentId }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(connection.refreshToken);
    // Nor does anything the OP logged about it (RULE-22 / RULE-51).
    expect([...op.ledgerLogs, ...op.connectionLogs].join('\n')).not.toContain(connection.refreshToken);
  });

  it('refuses a caller that is not the lifecycle manager', async () => {
    const idp = await startHumanIdp();
    const idpFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      idp.fetch(new URL(String(input)).pathname, init)) as unknown as typeof fetch;
    const shared = createFirestoreDouble();
    const op = await startOp(shared, idpFetch);
    await seedConnection(op, (await connectHuman(idp)).refreshToken);

    const response = await op.fetch('/internal/revoke-connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sa-someone-else@xaa-test.iam.gserviceaccount.com' },
      body: JSON.stringify({ agent_id: op.agentId }),
    });
    expect(response.status).toBe(403);
  });
});
