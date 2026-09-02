import { beforeAll, describe, expect, it } from 'vitest';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import { callResource, redeemForAccessToken, seedDocument, startResource } from '../../harness/resource.js';

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

// A read plus write grant: the API needs docs.read for GET and docs.write for POST
// and PATCH, so a write-only token could not read back what it created.
async function writer(scope = 'docs.read docs.write') {
  const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
  const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
  const idJag = (await (await requestIdJag(agentOp, { subjectToken, scope })).json() as { access_token: string }).access_token;
  const accessToken = (await (await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair })).json() as { access_token: string }).access_token;
  return { agentOp, docs, accessToken, keyPair: agentOp.dpopKeyPair };
}

describe('Document API', () => {
  it('creates, reads back and updates a document', async () => {
    const { docs, accessToken, keyPair } = await writer();
    const created = await callResource(docs, {
      method: 'POST', path: '/documents', accessToken, keyPair, toolId: 'internal.document.create',
      body: { type: 'daily_report', title: '日報', body: '本文', occurred_at: new Date().toISOString() },
    });
    expect(created.status).toBe(201);
    const documentId = (await created.json() as { document_id: string }).document_id;
    expect(documentId.startsWith('doc_')).toBe(true);

    const fetched = await callResource(docs, { method: 'GET', path: `/documents/${documentId}`, accessToken, keyPair });
    expect(fetched.status).toBe(200);
    const document = await fetched.json() as { owner_subject: string; version: number; body: string };
    expect(document.owner_subject).toBe('testuser');
    expect(document.version).toBe(1);

    const patched = await callResource(docs, {
      method: 'PATCH', path: `/documents/${documentId}`, accessToken, keyPair,
      body: { version: 1, title: '改題' },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json() as { version: number }).version).toBe(2);
  });

  it('takes the owner from the token, never from the body', async () => {
    const { docs, accessToken, keyPair } = await writer();
    const created = await callResource(docs, {
      method: 'POST', path: '/documents', accessToken, keyPair,
      body: { type: 'note', title: 't', body: 'b', occurred_at: new Date().toISOString(), owner_subject: 'someone-else' },
    });
    // owner_subject is not part of the create schema, so the body is rejected
    // outright rather than the value being quietly dropped.
    expect(created.status).toBe(400);
  });

  it('answers 409 on a stale version and leaves the record alone', async () => {
    const { docs, accessToken, keyPair } = await writer();
    const documentId = await seedDocument(docs, 'testuser', { title: 'original' });
    const conflict = await callResource(docs, {
      method: 'PATCH', path: `/documents/${documentId}`, accessToken, keyPair, body: { version: 99, title: 'changed' },
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: string }).error).toBe('version_conflict');
    const after = await callResource(docs, { method: 'GET', path: `/documents/${documentId}`, accessToken, keyPair });
    expect((await after.json() as { title: string; version: number }).title).toBe('original');
  });

  it('answers 404 for another owner\'s document', async () => {
    const { docs, accessToken, keyPair } = await writer();
    const documentId = await seedDocument(docs, 'another-user');
    const response = await callResource(docs, { method: 'GET', path: `/documents/${documentId}`, accessToken, keyPair });
    expect(response.status).toBe(404);
  });

  it('omits the body from the list projection', async () => {
    const { docs, accessToken, keyPair } = await writer();
    await seedDocument(docs, 'testuser');
    const response = await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair });
    const { documents } = await response.json() as { documents: Array<Record<string, unknown>> };
    expect(documents.length).toBeGreaterThan(0);
    for (const summary of documents) {
      expect(Object.keys(summary).sort()).toEqual(['document_id', 'occurred_at', 'title', 'type']);
    }
  });

  it('rejects a limit above 100 and a type outside the enum', async () => {
    const { docs, accessToken, keyPair } = await writer();
    expect((await callResource(docs, { method: 'GET', path: '/documents?limit=500', accessToken, keyPair })).status).toBe(400);
    expect((await callResource(docs, {
      method: 'POST', path: '/documents', accessToken, keyPair,
      body: { type: 'invoice', title: 't', body: 'b', occurred_at: new Date().toISOString() },
    })).status).toBe(400);
  });

  it('logs seven fields plus both subjects, on success and on refusal', async () => {
    const { docs, accessToken, keyPair } = await writer();
    await seedDocument(docs, 'testuser');
    await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair, toolId: 'internal.document.list' });
    await callResource(docs, { method: 'GET', path: '/documents', accessToken, keyPair, omitProof: true });
    const access = docs.logs.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown>; human_subject: unknown; agent_id: unknown })
      .filter((entry) => entry.event === 'resource_api.access');
    expect(access.length).toBeGreaterThanOrEqual(2);
    for (const entry of access) {
      for (const field of ['tool_id', 'operation', 'http_method', 'resource', 'response_status', 'outcome', 'latency_ms']) {
        expect(Object.keys(entry.fields)).toContain(field);
      }
    }
    expect(access.some((entry) => entry.human_subject === 'testuser' && entry.agent_id !== null)).toBe(true);
    expect(access.some((entry) => String(entry.fields.outcome).startsWith('error:'))).toBe(true);
    expect(docs.logs.join('\n')).not.toContain(accessToken);
  });

  it('lets a docs.read token read but not update', async () => {
    const writer0 = await writer();
    const documentId = await seedDocument(writer0.docs, 'testuser');
    // A second agent against the same Resource, holding the read scope alone.
    const reader = await writer('docs.read');
    expect((await callResource(writer0.docs, {
      method: 'GET', path: `/documents/${documentId}`, accessToken: writer0.accessToken, keyPair: writer0.keyPair,
    })).status).toBe(200);

    const readerDocument = await seedDocument(reader.docs, 'testuser');
    expect((await callResource(reader.docs, {
      method: 'GET', path: `/documents/${readerDocument}`, accessToken: reader.accessToken, keyPair: reader.keyPair,
    })).status).toBe(200);
    const patched = await callResource(reader.docs, {
      method: 'PATCH', path: `/documents/${readerDocument}`, accessToken: reader.accessToken, keyPair: reader.keyPair,
      body: { version: 1, title: 'changed' },
    });
    expect(patched.status).toBe(403);
    expect((await patched.json() as { error: string }).error).toBe('insufficient_scope');
  });

  it('records an unregistered tool id as unknown without changing the answer', async () => {
    const { docs, accessToken, keyPair } = await writer();
    await seedDocument(docs, 'testuser');
    const response = await callResource(docs, {
      method: 'GET', path: '/documents', accessToken, keyPair, toolId: 'internal.document.exfiltrate',
    });
    expect(response.status).toBe(200);
    const entry = docs.logs.map((line) => JSON.parse(line) as { event: string; fields: { tool_id: string } })
      .filter((line) => line.event === 'resource_api.access').at(-1);
    expect(entry!.fields.tool_id).toBe('unknown');
  });
});
