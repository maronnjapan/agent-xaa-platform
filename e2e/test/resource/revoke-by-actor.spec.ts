import { beforeAll, describe, expect, it } from 'vitest';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import { callResource, redeemForAccessToken, seedDocument, startResource } from '../../harness/resource.js';

const LIFECYCLE_SA = 'sa-lifecycle@xaa-test.iam.gserviceaccount.com';

let idpJwk: JsonWebKey;
let subjectToken: string;

beforeAll(async () => {
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
  subjectToken = (await response.json() as { id_token: string }).id_token;
  idpJwk = await idpPublicJwk();
});

async function chain() {
  const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
  const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
  const idJag = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
  const accessToken = (await (await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair })).json() as { access_token: string }).access_token;
  await seedDocument(docs, 'testuser');
  const revoke = (body: unknown, caller = LIFECYCLE_SA) => docs.api('/internal/revoke-by-actor', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${caller}` },
    body: JSON.stringify(body),
  });
  return { agentOp, docs, accessToken, keyPair: agentOp.dpopKeyPair, revoke, actSub: `urn:xaa:agent:${agentOp.agentId}` };
}

/**
 * T-RES-22. An Access Token is a JWT, so revocation cannot be "forget the token": it
 * is a ledger both Resource APIs and both Authorization Servers consult. Cleanup
 * calls this endpoint once per agent and expects every door to close.
 */
describe('POST /internal/revoke-by-actor', () => {
  it('refuses a caller that is not the lifecycle service account', async () => {
    const { revoke, actSub } = await chain();
    expect((await revoke({ act_sub: actSub }, 'sa-provisioner@xaa-test.iam.gserviceaccount.com')).status).toBe(403);
  });

  it('turns a working Access Token into 401 token_revoked', async () => {
    const { docs, accessToken, keyPair, revoke, actSub } = await chain();
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair })).status).toBe(200);

    expect((await revoke({ act_sub: actSub })).status).toBe(200);

    // The ledger write drops the cached answer, so the next call reads the record
    // rather than waiting out the 10-second cache.
    const after = await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair });
    expect(after.status).toBe(401);
    expect((await after.json() as { error: string }).error).toBe('token_revoked');
  });

  it('stops the agent getting a fresh token from the Authorization Server', async () => {
    const { agentOp, docs, revoke, actSub } = await chain();
    expect((await revoke({ act_sub: actSub })).status).toBe(200);
    const idJag = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const response = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('answers 200 twice and keeps the first revoked_at', async () => {
    const { docs, revoke, actSub } = await chain();
    expect((await revoke({ act_sub: actSub })).status).toBe(200);
    const first = await docs.documents.get<{ revoked_at: string }>('revoked_actors', Buffer.from(actSub, 'utf8').toString('base64url'));
    expect((await revoke({ act_sub: actSub })).status).toBe(200);
    const second = await docs.documents.get<{ revoked_at: string }>('revoked_actors', Buffer.from(actSub, 'utf8').toString('base64url'));
    expect(second!.revoked_at).toBe(first!.revoked_at);
  });

  it('answers 200 for an actor it has never seen', async () => {
    const { revoke } = await chain();
    expect((await revoke({ act_sub: 'urn:xaa:agent:agent-zzzzzzzzzzzzzzzzzzzzzzzzzz' })).status).toBe(200);
  });
});
