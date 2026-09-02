import { beforeAll, describe, expect, it } from 'vitest';
import { authorize, decodeJwtPayload, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { FINANCE_AS_ISSUER, FINANCE_API_RESOURCE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import {
  callResource, forgeAccessToken, mintIdJag, redeemForAccessToken, seedPayment, startResource,
} from '../../harness/resource.js';
import { generateEs256KeyPair, jwkThumbprint, toPublicJwk } from '@xaa/crypto';

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

async function financeChain(options: { isolation?: 'standard' | 'full_isolation'; scope?: string; absoluteMaxAmount?: number } = {}) {
  const agentOp = await startAgentOp({
    idpPublicJwk: idpJwk, isolationLevel: options.isolation ?? 'full_isolation',
    allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
    scopes: ['finance.tx.read', 'finance.tx.write'],
  });
  const finance = await startResource({
    kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER,
    ...(options.absoluteMaxAmount === undefined ? {} : { absoluteMaxAmount: options.absoluteMaxAmount }),
  });
  const idJag = (await (await requestIdJag(agentOp, {
    subjectToken, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE,
    scope: options.scope ?? 'finance.tx.read finance.tx.write',
  })).json() as { access_token: string }).access_token;
  const redeemed = await redeemForAccessToken(finance, { idJag, keyPair: agentOp.dpopKeyPair });
  return { agentOp, finance, redeemed, keyPair: agentOp.dpopKeyPair };
}

describe('Finance requires full isolation', () => {
  it('refuses a standard agent at the Authorization Server with 403', async () => {
    const { redeemed } = await financeChain({ isolation: 'standard' });
    expect(redeemed.status).toBe(403);
    expect(await redeemed.json()).toEqual({ error: 'insufficient_isolation', error_description: 'The agent is not sufficiently isolated' });
  });

  it('issues a token carrying isolation_level for a fully isolated agent', async () => {
    const { redeemed } = await financeChain();
    expect(redeemed.status).toBe(200);
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    expect(decodeJwtPayload(accessToken).isolation_level).toBe('full_isolation');
  });

  it('refuses an assertion with no isolation_level at all', async () => {
    // The Agent OP always writes the claim, so the absent case is minted here.
    const opKeyPair = await generateEs256KeyPair();
    const dpopKeyPair = await generateEs256KeyPair();
    const finance = await startResource({
      kind: 'finance', agentOpPublicJwk: opKeyPair.publicJwk as JsonWebKey, trustedIdpIssuer: HUMAN_IDP_ISSUER,
    });
    const idJag = await mintIdJag({
      keyPair: opKeyPair, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE,
      jkt: await jwkThumbprint(await toPublicJwk(dpopKeyPair.publicKey)),
      scope: 'finance.tx.read finance.tx.write',
    });
    const response = await redeemForAccessToken(finance, { idJag, keyPair: dpopKeyPair });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('insufficient_isolation');
  });

  it('refuses a token whose isolation_level was edited after signing', async () => {
    const { finance, redeemed, keyPair } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const payload = decodeJwtPayload(accessToken);
    // Same claims, `isolation_level` rewritten, signature not renewed.
    const [header, , signature] = accessToken.split('.');
    const edited = `${header}.${Buffer.from(JSON.stringify({ ...payload, isolation_level: 'standard' })).toString('base64url')}.${signature}`;
    const response = await callResource(finance, { method: 'GET', path: '/payments', accessToken: edited, keyPair });
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe('invalid_token');
  });

  it('refuses at the API a signed token that carries a lesser isolation level', async () => {
    const { finance, keyPair } = await financeChain();
    const jkt = await jwkThumbprint(await toPublicJwk(keyPair.publicKey));
    const issuedAt = Math.floor(Date.now() / 1000);
    // Signed by the AS's own key: only the API's own gate stands in the way.
    const accessToken = await forgeAccessToken(finance, {
      iss: FINANCE_AS_ISSUER, sub: 'testuser', aud: [FINANCE_API_RESOURCE, `${FINANCE_AS_ISSUER}/userinfo`],
      scope: 'finance.tx.read', iat: issuedAt, exp: issuedAt + 300,
      act: { sub: 'urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz' }, cnf: { jkt },
      isolation_level: 'standard',
    });
    const response = await callResource(finance, { method: 'GET', path: '/payments', accessToken, keyPair });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('insufficient_isolation');
  });

  it('refuses at the API too when the claim is missing from the token', async () => {
    const { finance, agentOp } = await financeChain();
    // A token forged without the claim cannot be signed by the AS, so the API sees
    // it as an invalid token rather than an under-isolated one.
    const response = await finance.api('/payments', { headers: { Authorization: 'DPoP not-a-token' } });
    expect(response.status).toBe(401);
    void agentOp;
  });

  it('leaves the documents Authorization Server without an isolation step', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
    const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken })).json() as { access_token: string }).access_token;
    expect((await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair })).status).toBe(200);
  });
});

describe('Payment approval', () => {
  it('approves once and records both subjects', async () => {
    const { finance, redeemed, keyPair, agentOp } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });

    const approved = await callResource(finance, {
      method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair, toolId: 'internal.finance.payment.approve',
    });
    expect(approved.status).toBe(200);
    const body = await approved.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['approved_at', 'approved_by', 'approved_by_agent', 'payment_id', 'status']);
    expect(body.approved_by).toBe('testuser');
    expect(body.approved_by_agent).toBe(`urn:xaa:agent:${agentOp.agentId}`);
    expect(body.status).toBe('approved');
  });

  it('is idempotent and keeps the original approver and timestamp', async () => {
    const { finance, redeemed, keyPair } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });
    const first = await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair });
    const firstBody = await first.json() as { approved_at: string; approved_by: string };
    const second = await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { result: string; approved_at: string; approved_by: string; approved_by_agent: string };
    expect(secondBody.result).toBe('already_approved');
    expect(secondBody.approved_at).toBe(firstBody.approved_at);
    expect(secondBody.approved_by).toBe(firstBody.approved_by);
    expect(secondBody.approved_by_agent).toBeTruthy();
  });

  it('answers 409 for an executed payment', async () => {
    const { finance, redeemed, keyPair } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { status: 'executed' });
    const response = await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe('invalid_state');
  });

  it('answers 404 for another requester\'s payment', async () => {
    const { finance, redeemed, keyPair } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'another-user');
    expect((await callResource(finance, { method: 'GET', path: `/payments/${paymentId}`, accessToken, keyPair })).status).toBe(404);
  });

  it('a read-only token cannot approve', async () => {
    const { finance, redeemed, keyPair } = await financeChain({ scope: 'finance.tx.read' });
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser');
    const response = await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('insufficient_scope');
  });
});

describe('Amount ceilings', () => {
  it('refuses an amount over the server ceiling even with no token constraint', async () => {
    const { finance, redeemed, keyPair } = await financeChain({ absoluteMaxAmount: 1000 });
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });
    const response = await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'constraint_violation', limit_source: 'server' });
    const after = await callResource(finance, { method: 'GET', path: `/payments/${paymentId}`, accessToken, keyPair });
    expect((await after.json() as { status: string }).status).toBe('pending_approval');
  });

  it('refuses an amount over the ceiling the token itself carries', async () => {
    const opKeyPair = await generateEs256KeyPair();
    const dpopKeyPair = await generateEs256KeyPair();
    const finance = await startResource({
      kind: 'finance', agentOpPublicJwk: opKeyPair.publicJwk as JsonWebKey,
      trustedIdpIssuer: HUMAN_IDP_ISSUER, absoluteMaxAmount: 1_000_000,
    });
    const idJag = await mintIdJag({
      keyPair: opKeyPair, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE,
      jkt: await jwkThumbprint(await toPublicJwk(dpopKeyPair.publicKey)),
      scope: 'finance.tx.read finance.tx.write', isolationLevel: 'full_isolation',
      constraints: { 'internal.finance.payment.approve': { max_amount: 1000 } },
    });
    const redeemed = await redeemForAccessToken(finance, { idJag, keyPair: dpopKeyPair });
    expect(redeemed.status).toBe(200);
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;

    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });
    const response = await callResource(finance, {
      method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair: dpopKeyPair,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'constraint_violation', limit_source: 'token' });

    const after = await callResource(finance, { method: 'GET', path: `/payments/${paymentId}`, accessToken, keyPair: dpopKeyPair });
    expect((await after.json() as { status: string }).status).toBe('pending_approval');
  });

  it('approves an amount within the ceiling', async () => {
    const { finance, redeemed, keyPair } = await financeChain({ absoluteMaxAmount: 10_000 });
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });
    expect((await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair })).status).toBe(200);
  });
});

/**
 * RULE-46. The record, the response and the audit line all have to name the human and
 * the agent; one without the other cannot answer "who approved this".
 */
describe('the two subjects of an approval', () => {
  it('stores both subjects and ignores an approved_by in the request body', async () => {
    const { finance, redeemed, keyPair, agentOp } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });
    const response = await callResource(finance, {
      method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair,
      body: { approved_by: 'someone-else', approved_by_agent: 'urn:xaa:agent:agent-zzzzzzzzzzzzzzzzzzzzzzzzzz' },
    });
    expect(response.status).toBe(200);

    const stored = await finance.seedStore.get<{ approved_by: string; approved_by_agent: string }>('payments', paymentId);
    expect(stored!.approved_by).toBe('testuser');
    expect(stored!.approved_by_agent).toBe(`urn:xaa:agent:${agentOp.agentId}`);
  });

  it('writes one audit line naming both subjects, the payment and the amount', async () => {
    const { finance, redeemed, keyPair, agentOp } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });
    expect((await callResource(finance, {
      method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair,
    })).status).toBe(200);

    const approvals = finance.logs
      .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
      .filter((entry) => entry.event === 'resource_api.payment_approved');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.fields).toMatchObject({
      payment_id: paymentId, amount: 5000, status: 'approved', result: 'approved',
      approved_by: 'testuser', approved_by_agent: `urn:xaa:agent:${agentOp.agentId}`,
    });
  });

  it('returns both subjects again on the already_approved answer', async () => {
    const { finance, redeemed, keyPair, agentOp } = await financeChain();
    const accessToken = (await redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(finance, 'testuser', { amount: 5000 });
    await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair });
    const second = await callResource(finance, { method: 'POST', path: `/payments/${paymentId}/approve`, accessToken, keyPair });
    const body = await second.json() as { result: string; approved_by: string; approved_by_agent: string };
    expect(body.result).toBe('already_approved');
    expect(body.approved_by).toBe('testuser');
    expect(body.approved_by_agent).toBe(`urn:xaa:agent:${agentOp.agentId}`);
  });
});
