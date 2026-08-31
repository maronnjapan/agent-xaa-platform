import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair } from '@xaa/crypto';
import { authorize, decodeJwtHeader, decodeJwtPayload, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { requestIdJag, startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';
import { callResource, redeemForAccessToken, seedDocument, startResource, type ResourceHarness } from '../../harness/resource.js';

/**
 * REQ-01-023. The four Cross App Access steps end to end, in one process:
 * login -> ID Token, ID Token + agent assertion -> ID-JAG, ID-JAG + DPoP ->
 * Access Token, Access Token + DPoP -> data. Nothing is hand-minted; every token
 * comes from the service that actually issues it.
 */
async function humanIdToken(): Promise<string> {
  const idp = await startHumanIdp();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'agent-platform', clientSecret: 'agent-platform-secret', issuer: HUMAN_IDP_ISSUER,
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
      code_verifier: result.pkce.verifier, client_id: 'agent-platform',
    },
  });
  return (await response.json() as { id_token: string }).id_token;
}

export async function walkNativeXaa(): Promise<{ agentOp: AgentOpHarness; docs: ResourceHarness; accessToken: string; idJag: string }> {
  const subjectToken = await humanIdToken();
  const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
  const idJagResponse = await requestIdJag(agentOp, { subjectToken });
  expect(idJagResponse.status).toBe(200);
  const idJag = (await idJagResponse.json() as { access_token: string }).access_token;

  const docs = await startResource({
    kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER,
  });
  const redeemed = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair });
  expect(redeemed.status).toBe(200);
  const accessToken = (await redeemed.json() as { access_token: string }).access_token;
  return { agentOp, docs, accessToken, idJag };
}

describe('the native XAA path, end to end', () => {
  it('reaches GET /documents with a token nobody hand-minted', async () => {
    const { agentOp, docs, accessToken } = await walkNativeXaa();
    await seedDocument(docs, 'testuser');
    const response = await callResource(docs, {
      method: 'GET', path: '/documents', accessToken, keyPair: agentOp.dpopKeyPair, toolId: 'internal.document.list',
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { documents: unknown[] }).documents).toHaveLength(1);
  });

  it('carries the delegation all the way into the Access Token', async () => {
    const { agentOp, accessToken } = await walkNativeXaa();
    const claims = decodeJwtPayload(accessToken);
    expect(decodeJwtHeader(accessToken).typ).toBe('at+jwt');
    expect(claims.sub).toBe('testuser');
    expect((claims.act as { sub: string }).sub).toBe(`urn:xaa:agent:${agentOp.agentId}`);
    expect((claims.cnf as { jkt: string }).jkt).toBeTruthy();
    expect(claims.isolation_level).toBe('standard');
  });

  it('answers DPoP, never Bearer, and issues no refresh or ID token', async () => {
    const subjectToken = await humanIdToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const body = await (await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair })).json() as Record<string, unknown>;
    expect(body.token_type).toBe('DPoP');
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
  });

  it('never touches the network: the harness stub is not called', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls += 1; throw new Error('the native XAA path must not reach the network'); }) as unknown as typeof fetch;
    try {
      const { agentOp, docs, accessToken } = await walkNativeXaa();
      await seedDocument(docs, 'testuser');
      expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair: agentOp.dpopKeyPair })).status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(0);
  });

  it('runs the redemption steps in the fixed order', async () => {
    const { docs } = await walkNativeXaa();
    expect(docs.redeemSteps).toEqual([
      'authorize_client', 'parse_params', 'verify_assertion', 'bind_cnf',
      'resolve_scope', 'registered_scope', 'isolation', 'revocation',
    ]);
  });

  it('rejects a proof made with a key the grant is not bound to', async () => {
    const subjectToken = await humanIdToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const response = await redeemForAccessToken(docs, {
      idJag, keyPair: agentOp.dpopKeyPair, proofKeyPair: await generateEs256KeyPair(),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a redemption with no proof at all', async () => {
    const subjectToken = await humanIdToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    expect((await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair, omitProof: true })).status).toBe(400);
  });
});
