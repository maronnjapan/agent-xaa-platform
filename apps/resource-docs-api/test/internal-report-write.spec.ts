import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createApp from '../src/app.js';

const AUTOMATION_APP_SA = 'sa-automation-app@xaa-test.iam.gserviceaccount.com';

/**
 * T-APP-05. `createInternalDocumentWriter` sits in front of `createResourceProtection`
 * on `/documents/*`: a matching caller is fully handled here, and everything else
 * (a stranger, the wrong method, the wrong `type`) falls through to the ordinary
 * DPoP-protected pipeline, which answers 401 because none of these callers ever
 * present a `DPoP <token>` Authorization header.
 */
function app() {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api');
  const application = createApp({
    documents, asIssuer: 'https://resource-docs-as.test', resourceUri: 'https://resource-docs-api.test',
    jwksUrl: 'https://storage.test/jwks.json',
    logger: createLogger('resource-docs-api', 'resource_api', () => {}),
    // The double treats the bearer value itself as the caller's identity, the same
    // trick internal-revoke.spec.ts uses for `serviceIdentity`.
    serviceIdentity: { async verify(authorization) { return authorization?.replace(/^Bearer /, '') ?? null; } },
    lifecycleServiceAccount: 'sa-lifecycle@xaa-test.iam.gserviceaccount.com',
    automationAppServiceAccount: AUTOMATION_APP_SA,
  });
  return {
    documents,
    call: (body: unknown, caller = AUTOMATION_APP_SA) => application.fetch(new Request('https://resource-docs-api.test/documents', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${caller}` },
      body: JSON.stringify(body),
    })),
    get: (method: string, caller = AUTOMATION_APP_SA) => application.fetch(new Request('https://resource-docs-api.test/documents', {
      method, headers: { authorization: `Bearer ${caller}` },
    })),
  };
}

const VALID_BODY = {
  human_subject: 'testuser', type: 'daily_report', title: '9月1日の日報',
  body: '午前は集計、午後は確認', occurred_at: '2026-09-01T09:00:00.000Z',
};

describe('POST /documents, the internal report writer', () => {
  it('accepts the Automation App service identity and creates the document under human_subject', async () => {
    const { call, documents } = app();
    const response = await call(VALID_BODY);
    expect(response.status).toBe(201);
    const { document_id: documentId } = await response.json() as { document_id: string };
    expect(documentId).toMatch(/^doc_/);
    const stored = await documents.get<{ type: string; owner_subject: string; title: string }>('documents', documentId);
    expect(stored).toMatchObject({ type: 'daily_report', owner_subject: 'testuser', title: VALID_BODY.title });
  });

  it('refuses a caller that is not sa-automation-app (falls through to 401, not 403)', async () => {
    const { call } = app();
    const response = await call(VALID_BODY, 'sa-someone-else@xaa-test.iam.gserviceaccount.com');
    expect(response.status).toBe(401);
  });

  it('refuses an unauthenticated caller', async () => {
    const { call } = app();
    const response = await call(VALID_BODY, '');
    expect(response.status).toBe(401);
  });

  it('rejects any type other than daily_report', async () => {
    const { call } = app();
    const response = await call({ ...VALID_BODY, type: 'note' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('rejects a body missing human_subject', async () => {
    const { call } = app();
    const withoutSubject: Record<string, unknown> = { ...VALID_BODY };
    delete withoutSubject.human_subject;
    const response = await call(withoutSubject);
    expect(response.status).toBe(400);
  });

  it('rejects an extra field the way every other create route does', async () => {
    const { call } = app();
    const response = await call({ ...VALID_BODY, owner_subject: 'someone-else' });
    expect(response.status).toBe(400);
  });

  it('never opens a read: GET /documents with the same identity is 401, not 200', async () => {
    const { get } = app();
    const response = await get('GET');
    expect(response.status).toBe(401);
  });

  it('does not create a document when the caller or the body is refused', async () => {
    const { call, documents } = app();
    await call(VALID_BODY, 'sa-someone-else@xaa-test.iam.gserviceaccount.com');
    await call({ ...VALID_BODY, type: 'note' });
    const rows = await documents.queryEqual('documents', [['type', 'daily_report']]);
    expect(rows).toHaveLength(0);
  });
});
