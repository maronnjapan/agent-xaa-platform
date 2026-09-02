import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, toPublicJwk, type Es256KeyPair } from '@xaa/crypto';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { FINANCE_AS_ISSUER, FINANCE_API_RESOURCE, requestIdJag, startAgentOp, type AgentOpHarness, type StartAgentOpOptions } from '../../harness/agent-op.js';
import {
  callResource, forgeAccessToken, mintIdJag, MINTED_ACTOR_URN, redeemForAccessToken, seedDocument,
  startResource, type ResourceHarness,
} from '../../harness/resource.js';
import { DOCS_AS_ISSUER, DOCS_API_RESOURCE } from '../../harness/agent-op.js';

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

async function chain(options: Partial<StartAgentOpOptions> = {}) {
  const agentOp = await startAgentOp({ idpPublicJwk: idpJwk, ...options });
  const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
  return { agentOp, docs };
}

async function accessTokenFor(agentOp: AgentOpHarness, docs: ResourceHarness, options: { audience?: string; resource?: string; scope?: string } = {}) {
  const idJag = (await (await requestIdJag(agentOp, { subjectToken, ...options })).json() as { access_token: string }).access_token;
  const redeemed = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair });
  expect(redeemed.status).toBe(200);
  return (await redeemed.json() as { access_token: string }).access_token;
}

describe('Resource AS refuses every malformed presentation', () => {
  it('no assertion at all is invalid_request', async () => {
    const { docs } = await chain();
    const response = await docs.as('/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', client_id: 'agent-platform' }).toString(),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('an audience meant for another resource is invalid_grant', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk, allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE], scopes: ['finance.tx.read'] });
    const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE, scope: 'finance.tx.read' })).json() as { access_token: string }).access_token;
    const response = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('a grant signed by an untrusted key is invalid_grant', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
    const stranger = await startAgentOp({ idpPublicJwk: idpJwk, agentId: agentOp.agentId });
    const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const idJag = (await (await requestIdJag(stranger, { subjectToken })).json() as { access_token: string }).access_token;
    const response = await redeemForAccessToken(docs, { idJag, keyPair: stranger.dpopKeyPair });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('a proof made with another key is invalid_grant', async () => {
    const { agentOp, docs } = await chain();
    const idJag = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const response = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair, proofKeyPair: await generateEs256KeyPair() });
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('a replayed proof jti is invalid_grant', async () => {
    const { agentOp, docs } = await chain();
    const first = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const second = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const proof = await createDpopProof({ method: 'POST', url: `${docs.asIssuer}/token`, keyPair: agentOp.dpopKeyPair });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', DPoP: proof };
    const body = (assertion: string) => new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion, client_id: 'agent-platform' }).toString();
    expect((await docs.as('/token', { method: 'POST', headers, body: body(first) })).status).toBe(200);
    const replay = await docs.as('/token', { method: 'POST', headers, body: body(second) });
    expect(replay.status).toBe(400);
    expect((await replay.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('the token-exchange grant is unsupported here', async () => {
    const { docs } = await chain();
    const response = await docs.as('/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: 'agent-platform' }).toString(),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('unsupported_grant_type');
  });
});

describe('Resource API refuses every malformed presentation', () => {
  let agentOp: AgentOpHarness;
  let docs: ResourceHarness;
  let accessToken: string;
  let keyPair: Es256KeyPair;

  beforeAll(async () => {
    ({ agentOp, docs } = await chain());
    accessToken = await accessTokenFor(agentOp, docs);
    keyPair = agentOp.dpopKeyPair;
    await seedDocument(docs, 'testuser');
  });

  it('a Cloud Run ID Token alone is 401 with both challenges', async () => {
    const response = await docs.api('/documents', { headers: { Authorization: 'Bearer google-issued-id-token' } });
    expect(response.status).toBe(401);
    const challenges = response.headers.get('WWW-Authenticate') ?? '';
    expect(challenges).toContain('DPoP');
    expect(challenges).toContain('Bearer');
  });

  it('a request with no proof is 401', async () => {
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair, omitProof: true })).status).toBe(401);
  });

  it('a proof made with another key is 401', async () => {
    const response = await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair, proofKeyPair: await generateEs256KeyPair() });
    expect(response.status).toBe(401);
  });

  it('a proof whose ath does not match is 401', async () => {
    const proof = await createDpopProof({
      method: 'GET', url: `${docs.resourceUri}/documents`, keyPair, accessToken: 'a-different-token',
    });
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair, proof })).status).toBe(401);
  });

  it('a replayed proof is 401', async () => {
    const proof = await createDpopProof({ method: 'GET', url: `${docs.resourceUri}/documents`, keyPair, accessToken });
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair, proof })).status).toBe(200);
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair, proof })).status).toBe(401);
  });

  it('a token minted for another instance of this resource does not pass', async () => {
    const other = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const response = await other.api('/documents', { headers: { Authorization: `DPoP ${accessToken}` } });
    expect(response.status).toBe(401);
  });

  it('a read-only token cannot write', async () => {
    const response = await callResource(docs, {
      method: 'POST', path: '/documents', accessToken, keyPair,
      body: { type: 'note', title: 't', body: 'b', occurred_at: new Date().toISOString() },
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('insufficient_scope');
  });

  it('a revoked actor is refused at both the API and the AS', async () => {
    const fresh = await chain();
    const token = await accessTokenFor(fresh.agentOp, fresh.docs);
    await seedDocument(fresh.docs, 'testuser');
    expect((await callResource(fresh.docs, { method: 'GET', path: '/documents', accessToken: token, keyPair: fresh.agentOp.dpopKeyPair })).status).toBe(200);

    await fresh.docs.ledger.revoke(`urn:xaa:agent:${fresh.agentOp.agentId}`);
    expect((await callResource(fresh.docs, { method: 'GET', path: '/documents', accessToken: token, keyPair: fresh.agentOp.dpopKeyPair })).status).toBe(401);

    const idJag = (await (await requestIdJag(fresh.agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    const response = await redeemForAccessToken(fresh.docs, { idJag, keyPair: fresh.agentOp.dpopKeyPair });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });
});

/**
 * The assertion-shaped refusals. These are minted here rather than requested from the
 * Agent OP because the Agent OP cannot produce them: it never signs a wrong
 * `client_id`, never embeds a key in the header, never omits `cnf`.
 */
describe('Resource AS refuses a malformed assertion', () => {
  async function mintedChain() {
    const opKeyPair = await generateEs256KeyPair();
    const dpopKeyPair = await generateEs256KeyPair();
    const jkt = await jwkThumbprint(await toPublicJwk(dpopKeyPair.publicKey));
    const docs = await startResource({
      kind: 'docs', agentOpPublicJwk: opKeyPair.publicJwk as JsonWebKey, trustedIdpIssuer: HUMAN_IDP_ISSUER,
    });
    const mint = (overrides: Record<string, unknown> = {}) => mintIdJag({
      keyPair: opKeyPair, audience: DOCS_AS_ISSUER, resource: DOCS_API_RESOURCE, jkt, ...overrides,
    });
    return { docs, dpopKeyPair, mint };
  }

  async function refusal(assertion: string, keyPair: Es256KeyPair, docs: ResourceHarness) {
    const response = await redeemForAccessToken(docs, { idJag: assertion, keyPair });
    expect(response.status).toBe(400);
    return (await response.json() as { error: string }).error;
  }

  it('accepts the baseline this file then breaks one field at a time', async () => {
    const { docs, dpopKeyPair, mint } = await mintedChain();
    expect((await redeemForAccessToken(docs, { idJag: await mint(), keyPair: dpopKeyPair })).status).toBe(200);
  });

  it('a client_id other than the presented client is invalid_grant', async () => {
    const { docs, dpopKeyPair, mint } = await mintedChain();
    expect(await refusal(await mint({ clientId: 'another-client' }), dpopKeyPair, docs)).toBe('invalid_grant');
  });

  it('a jwk header is invalid_grant', async () => {
    const { docs, dpopKeyPair, mint } = await mintedChain();
    expect(await refusal(await mint({ embedJwk: true }), dpopKeyPair, docs)).toBe('invalid_grant');
  });

  it('an assertion with no cnf is invalid_grant', async () => {
    const { docs, dpopKeyPair, mint } = await mintedChain();
    expect(await refusal(await mint({ jkt: null }), dpopKeyPair, docs)).toBe('invalid_grant');
  });
});

/**
 * The token-shaped refusals. Each token below is signed by the Authorization Server's
 * real key, so only the guard's own checks stand between it and the data.
 */
describe('Resource API refuses a token the AS would never mint', () => {
  let docs: ResourceHarness;
  let keyPair: Es256KeyPair;
  let jkt: string;

  beforeAll(async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
    docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    keyPair = agentOp.dpopKeyPair;
    jkt = await jwkThumbprint(await toPublicJwk(keyPair.publicKey));
    await seedDocument(docs, 'testuser');
  });

  const claims = (overrides: Record<string, unknown> = {}) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    return {
      iss: DOCS_AS_ISSUER, sub: 'testuser', aud: [DOCS_API_RESOURCE, `${DOCS_AS_ISSUER}/userinfo`],
      scope: 'docs.read docs.write', iat: issuedAt, exp: issuedAt + 300,
      act: { sub: MINTED_ACTOR_URN }, cnf: { jkt }, ...overrides,
    };
  };

  it('accepts the baseline this block then breaks one claim at a time', async () => {
    const accessToken = await forgeAccessToken(docs, claims());
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair })).status).toBe(200);
  });

  it('a token whose typ is not at+jwt is 401', async () => {
    const accessToken = await forgeAccessToken(docs, claims(), { typ: 'jwt' });
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair })).status).toBe(401);
  });

  it('an aud that only shares a prefix with this resource is 401', async () => {
    const accessToken = await forgeAccessToken(docs, claims({ aud: [`${DOCS_API_RESOURCE}/extra`, `${DOCS_AS_ISSUER}/userinfo`] }));
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair })).status).toBe(401);
  });

  it('a token with no act is 401', async () => {
    const withoutAct = claims();
    delete (withoutAct as Record<string, unknown>).act;
    const accessToken = await forgeAccessToken(docs, withoutAct);
    expect((await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair })).status).toBe(401);
  });
});
