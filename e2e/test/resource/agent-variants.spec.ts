import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { FINANCE_AS_ISSUER, FINANCE_API_RESOURCE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import { callResource, redeemForAccessToken, seedDocument, seedPayment, startResource } from '../../harness/resource.js';

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

async function docsAgent(scope: string) {
  const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
  const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
  const idJag = (await (await requestIdJag(agentOp, { subjectToken, scope })).json() as { access_token: string }).access_token;
  const redeemed = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair });
  return { agentOp, harness: docs, redeemed, keyPair: agentOp.dpopKeyPair };
}

async function financeAgent(options: { isolation: 'standard' | 'full_isolation'; scope: string }) {
  const agentOp = await startAgentOp({
    idpPublicJwk: idpJwk, isolationLevel: options.isolation,
    allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
    scopes: ['finance.tx.read', 'finance.tx.write'],
  });
  const finance = await startResource({ kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
  const idJag = (await (await requestIdJag(agentOp, {
    subjectToken, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE, scope: options.scope,
  })).json() as { access_token: string }).access_token;
  const redeemed = await redeemForAccessToken(finance, { idJag, keyPair: agentOp.dpopKeyPair });
  return { agentOp, harness: finance, redeemed, keyPair: agentOp.dpopKeyPair };
}

/**
 * T-RES-23. Four agents, four different endings, in one file: what an agent may do
 * follows from the grant it holds, and nothing else. Read them together and the
 * branch points of the whole area are visible at once.
 */
describe('four agents, four outcomes', () => {
  it('separates read-only from write, and standard from fully isolated', async () => {
    // 1. A documents agent holding docs.read alone: it reads and cannot write.
    const reader = await docsAgent('docs.read');
    expect(reader.redeemed.status).toBe(200);
    const readerToken = (await reader.redeemed.json() as { access_token: string }).access_token;
    await seedDocument(reader.harness, 'testuser');
    expect((await callResource(reader.harness, {
      method: 'GET', path: '/documents', accessToken: readerToken, keyPair: reader.keyPair,
    })).status).toBe(200);
    const written = await callResource(reader.harness, {
      method: 'POST', path: '/documents', accessToken: readerToken, keyPair: reader.keyPair,
      body: { type: 'note', title: 't', body: 'b', occurred_at: new Date().toISOString() },
    });
    expect(written.status).toBe(403);
    expect((await written.json() as { error: string }).error).toBe('insufficient_scope');

    // 2. A finance agent holding finance.tx.read alone: it lists and cannot approve.
    const financeReader = await financeAgent({ isolation: 'full_isolation', scope: 'finance.tx.read' });
    expect(financeReader.redeemed.status).toBe(200);
    const financeReadToken = (await financeReader.redeemed.json() as { access_token: string }).access_token;
    const listed = await seedPayment(financeReader.harness, 'testuser', { amount: 1000 });
    expect((await callResource(financeReader.harness, {
      method: 'GET', path: '/payments', accessToken: financeReadToken, keyPair: financeReader.keyPair,
    })).status).toBe(200);
    const refusedApproval = await callResource(financeReader.harness, {
      method: 'POST', path: `/payments/${listed}/approve`, accessToken: financeReadToken, keyPair: financeReader.keyPair,
    });
    expect(refusedApproval.status).toBe(403);
    expect((await refusedApproval.json() as { error: string }).error).toBe('insufficient_scope');

    // 3. A fully isolated finance agent with the write scope: it approves.
    const approver = await financeAgent({ isolation: 'full_isolation', scope: 'finance.tx.read finance.tx.write' });
    expect(approver.redeemed.status).toBe(200);
    const approverToken = (await approver.redeemed.json() as { access_token: string }).access_token;
    const paymentId = await seedPayment(approver.harness, 'testuser', { amount: 5000 });
    expect((await callResource(approver.harness, {
      method: 'POST', path: `/payments/${paymentId}/approve`, accessToken: approverToken, keyPair: approver.keyPair,
    })).status).toBe(200);

    // 4. The same agent under standard isolation never gets a token at all.
    const standard = await financeAgent({ isolation: 'standard', scope: 'finance.tx.read finance.tx.write' });
    expect(standard.redeemed.status).toBe(403);
    expect((await standard.redeemed.json() as { error: string }).error).toBe('insufficient_isolation');
  });
});

describe('the resource suite talks to nothing outside the process', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('completes a whole documents flow without one outbound request', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error('the resource tests must not leave the process');
    }) as unknown as typeof fetch;

    const writer = await docsAgent('docs.read docs.write');
    expect(writer.redeemed.status).toBe(200);
    const accessToken = (await writer.redeemed.json() as { access_token: string }).access_token;
    const created = await callResource(writer.harness, {
      method: 'POST', path: '/documents', accessToken, keyPair: writer.keyPair,
      body: { type: 'note', title: 't', body: 'b', occurred_at: new Date().toISOString() },
    });
    expect(created.status).toBe(201);
    const documentId = (await created.json() as { document_id: string }).document_id;
    expect((await callResource(writer.harness, {
      method: 'GET', path: `/documents/${documentId}`, accessToken, keyPair: writer.keyPair,
    })).status).toBe(200);

    // Every JWK Set, every store and every peer service is injected, so no GCP
    // endpoint can be reached even by accident (T-RES-23).
    expect(calls).toEqual([]);
  });
});
