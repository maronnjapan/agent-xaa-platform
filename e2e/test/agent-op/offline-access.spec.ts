import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { completionCodeId, PROVISIONING_CODES_COLLECTION, type CompletionCodeRecord } from '@xaa/contracts';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { PROVISIONER_SA, startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';

/**
 * REQ-05-047. The offline_access consent, from the Provisioner's request for a consent
 * URL through the browser's return at /xaa/callback.
 *
 * The transaction's own status is moved by the Provisioner's resume route, not here:
 * Agent OP writes the connection and the one-time code and hands the browser back
 * (00b §3, and e2e/test/provisioning/consent-resume.spec.ts for that half).
 */
const refreshTokenResponse = (token = 'rt-1') => (async () => Response.json({
  refresh_token: token, access_token: 'at-1', id_token: 'id-1',
})) as unknown as typeof fetch;

async function consentUrl(agentOp: AgentOpHarness, options: { transactionId: string; expiresAt: string }): Promise<string> {
  const response = await agentOp.fetch('/internal/idp-connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISIONER_SA}` },
    body: JSON.stringify({
      agentId: agentOp.agentId,
      humanSubject: 'testuser',
      idpConnectionId: `idpconn-${agentOp.agentId}`,
      expiresAt: options.expiresAt,
      transactionId: options.transactionId,
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { status: string; consentUrl: string };
  expect(body.status).toBe('CONSENT_REQUIRED');
  return body.consentUrl;
}

describe('offline_access consent through /xaa/callback', () => {
  it('idp_connection becomes ACTIVE and the code for the Provisioner is written after consent', async () => {
    const shared = createFirestoreDouble();
    const idpJwk = await idpPublicJwk();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();

    // The token-mode service hands out the consent URL; the public callback service is
    // a second process over the same Firestore (DEC-IAC-14).
    const tokenFace = await startAgentOp({ shared, idpPublicJwk: idpJwk, expiresAt });
    const url = new URL(await consentUrl(tokenFace, { transactionId: 'txn-1', expiresAt }));
    expect(url.searchParams.get('scope')).toBe('openid offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;

    const store = createFirestoreDocumentStore(shared, 'agent-op');
    await store.set('provisioning_transactions', 'txn-1', { status: 'WAITING_IDP_CONSENT' });

    const callbackFace = await startAgentOp({
      shared, idpPublicJwk: idpJwk, agentId: tokenFace.agentId, expiresAt,
      config: { mode: 'callback' }, humanIdpFetch: refreshTokenResponse(),
    });
    const redirected = await callbackFace.fetch(`/xaa/callback?code=authz-code&state=${state}`);
    expect(redirected.status).toBe(302);

    const connection = await store.get<{ status: string; expires_at: string }>('idp_connections', `idpconn-${tokenFace.agentId}`);
    expect(connection!.status).toBe('ACTIVE');
    expect(connection!.expires_at).toBe(expiresAt);

    // The transaction is left for the Provisioner to move; what Agent OP leaves behind
    // is the redeemable code.
    expect((await store.get<{ status: string }>('provisioning_transactions', 'txn-1'))!.status).toBe('WAITING_IDP_CONSENT');
    const location = new URL(redirected.headers.get('location')!);
    expect(location.pathname).toBe('/provisioning/resume');
    const record = await store.get<CompletionCodeRecord>(
      PROVISIONING_CODES_COLLECTION, await completionCodeId(location.searchParams.get('code')!),
    );
    expect(record).toMatchObject({ transaction_id: 'txn-1', human_subject: 'testuser', used_at: null });
  });

  it('creates exactly one idp_connection per agent', async () => {
    const shared = createFirestoreDouble();
    const idpJwk = await idpPublicJwk();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const tokenFace = await startAgentOp({ shared, idpPublicJwk: idpJwk, expiresAt });
    const store = createFirestoreDocumentStore(shared, 'agent-op');

    const first = new URL(await consentUrl(tokenFace, { transactionId: 'txn-1', expiresAt }));
    const callbackFace = await startAgentOp({
      shared, idpPublicJwk: idpJwk, agentId: tokenFace.agentId, expiresAt,
      config: { mode: 'callback' }, humanIdpFetch: refreshTokenResponse(),
    });
    expect((await callbackFace.fetch(`/xaa/callback?code=c1&state=${first.searchParams.get('state')}`)).status).toBe(302);

    // Asked again for the same agent, the setup route reports the connection it already
    // has rather than starting a second consent.
    const second = await tokenFace.fetch('/internal/idp-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISIONER_SA}` },
      body: JSON.stringify({
        agentId: tokenFace.agentId, humanSubject: 'testuser',
        idpConnectionId: `idpconn-${tokenFace.agentId}`, expiresAt, transactionId: 'txn-1',
      }),
    });
    expect(await second.json()).toMatchObject({ status: 'READY', consentUrl: '' });

    const connections = await store.listAll<{ agent_id: string }>('idp_connections');
    expect(connections.filter((row) => row.data.agent_id === tokenFace.agentId)).toHaveLength(1);
  });
});
