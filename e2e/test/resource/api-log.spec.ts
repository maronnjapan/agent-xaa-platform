import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof } from '@xaa/crypto';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { FINANCE_AS_ISSUER, FINANCE_API_RESOURCE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import {
  callResource, redeemForAccessToken, seedDocument, seedPayment, startResource, type ResourceHarness,
} from '../../harness/resource.js';

/** REQ-09-012: the seven fields every Resource API call must carry. */
const ACCESS_FIELDS = ['tool_id', 'operation', 'http_method', 'resource', 'response_status', 'outcome', 'latency_ms'];

interface AccessLine {
  event: string;
  human_subject: unknown;
  agent_id: unknown;
  fields: Record<string, unknown>;
}

function accesses(harness: ResourceHarness): AccessLine[] {
  return harness.logs.map((line) => JSON.parse(line) as AccessLine).filter((entry) => entry.event === 'resource_api.access');
}

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

async function docsChain(scope = 'docs.read docs.write') {
  const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
  const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
  const idJag = (await (await requestIdJag(agentOp, { subjectToken, scope })).json() as { access_token: string }).access_token;
  const accessToken = (await (await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair })).json() as { access_token: string }).access_token;
  return { agentOp, docs, accessToken, keyPair: agentOp.dpopKeyPair };
}

async function financeChain() {
  const agentOp = await startAgentOp({
    idpPublicJwk: idpJwk, isolationLevel: 'full_isolation',
    allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
    scopes: ['finance.tx.read', 'finance.tx.write'],
  });
  const finance = await startResource({ kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
  const idJag = (await (await requestIdJag(agentOp, {
    subjectToken, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE, scope: 'finance.tx.read finance.tx.write',
  })).json() as { access_token: string }).access_token;
  const accessToken = (await (await redeemForAccessToken(finance, { idJag, keyPair: agentOp.dpopKeyPair })).json() as { access_token: string }).access_token;
  return { agentOp, finance, accessToken, keyPair: agentOp.dpopKeyPair };
}

describe('Resource API access log', () => {
  it('writes one line per call with the seven fields and both subjects', async () => {
    const docs = await docsChain();
    await seedDocument(docs.docs, 'testuser');
    expect((await callResource(docs.docs, {
      method: 'GET', path: '/documents', accessToken: docs.accessToken, keyPair: docs.keyPair,
      toolId: 'internal.document.list',
    })).status).toBe(200);
    expect((await callResource(docs.docs, {
      method: 'POST', path: '/documents', accessToken: docs.accessToken, keyPair: docs.keyPair,
      toolId: 'internal.document.create',
      body: { type: 'note', title: 't', body: 'b', occurred_at: new Date().toISOString() },
    })).status).toBe(201);

    const finance = await financeChain();
    const paymentId = await seedPayment(finance.finance, 'testuser', { amount: 1000 });
    expect((await callResource(finance.finance, {
      method: 'POST', path: `/payments/${paymentId}/approve`, accessToken: finance.accessToken,
      keyPair: finance.keyPair, toolId: 'internal.finance.payment.approve',
    })).status).toBe(200);

    const lines = [...accesses(docs.docs), ...accesses(finance.finance)];
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      for (const field of ACCESS_FIELDS) expect(Object.keys(line.fields)).toContain(field);
      expect(line.human_subject).toBe('testuser');
      expect(String(line.agent_id).startsWith('agent-')).toBe(true);
      expect(typeof line.fields.latency_ms).toBe('number');
    }
    expect(lines.map((line) => line.fields.operation))
      .toEqual(['document.list', 'document.create', 'payment.approve']);
  });

  it('writes the same seven fields on a 403 with outcome error:insufficient_scope', async () => {
    const docs = await docsChain('docs.read');
    const response = await callResource(docs.docs, {
      method: 'POST', path: '/documents', accessToken: docs.accessToken, keyPair: docs.keyPair,
      body: { type: 'note', title: 't', body: 'b', occurred_at: new Date().toISOString() },
    });
    expect(response.status).toBe(403);
    const line = accesses(docs.docs).at(-1)!;
    for (const field of ACCESS_FIELDS) expect(Object.keys(line.fields)).toContain(field);
    expect(line.fields.outcome).toBe('error:insufficient_scope');
    expect(line.fields.response_status).toBe(403);
  });

  it('leaves the subjects null on a 401 that never resolved a token', async () => {
    const docs = await docsChain();
    expect((await docs.docs.api('/documents', { headers: { Authorization: 'Bearer google-issued-id-token' } })).status).toBe(401);
    const line = accesses(docs.docs).at(-1)!;
    expect(line.human_subject).toBeNull();
    expect(line.agent_id).toBeNull();
    expect(line.fields.outcome).toBe('error:invalid_token');
  });

  it('never writes the Access Token or the DPoP proof into the log', async () => {
    const docs = await docsChain();
    await seedDocument(docs.docs, 'testuser');
    const proof = await createDpopProof({
      method: 'GET', url: `${docs.docs.resourceUri}/documents`, keyPair: docs.keyPair, accessToken: docs.accessToken,
    });
    expect((await callResource(docs.docs, {
      method: 'GET', path: '/documents', accessToken: docs.accessToken, keyPair: docs.keyPair, proof,
    })).status).toBe(200);
    const serialised = JSON.stringify(accesses(docs.docs));
    expect(serialised).not.toContain(docs.accessToken);
    expect(serialised).not.toContain(proof);
  });

  it('records an unregistered tool id as unknown and answers as usual', async () => {
    const docs = await docsChain();
    await seedDocument(docs.docs, 'testuser');
    const response = await callResource(docs.docs, {
      method: 'GET', path: '/documents', accessToken: docs.accessToken, keyPair: docs.keyPair,
      toolId: 'internal.document.exfiltrate',
    });
    expect(response.status).toBe(200);
    expect(accesses(docs.docs).at(-1)!.fields.tool_id).toBe('unknown');
  });
});
