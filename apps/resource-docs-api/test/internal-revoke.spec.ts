import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { createRevocationLedger, revocationDocumentId } from '@xaa/resource-guard';
import createApp from '../src/app.js';

const LIFECYCLE_SA = 'sa-lifecycle@xaa-test.iam.gserviceaccount.com';
const ACTOR = 'urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz';

function app(lines: string[] = []) {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api');
  const ledger = createRevocationLedger(documents);
  const application = createApp({
    documents, asIssuer: 'https://resource-docs-as.test', resourceUri: 'https://resource-docs-api.test',
    jwksUrl: 'https://storage.test/jwks.json',
    logger: createLogger('resource-docs-api', 'resource_api', (line) => { lines.push(line); }),
    // The double treats the bearer value itself as the caller's identity.
    serviceIdentity: { async verify(authorization) { return authorization?.replace(/^Bearer /, '') ?? null; } },
    lifecycleServiceAccount: LIFECYCLE_SA,
    revocationLedger: ledger,
  });
  return {
    ledger, documents,
    call: (body: unknown, caller = LIFECYCLE_SA) => application.fetch(new Request('https://resource-docs-api.test/internal/revoke-by-actor', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${caller}` },
      body: JSON.stringify(body),
    })),
  };
}

describe('POST /internal/revoke-by-actor', () => {
  it('refuses a caller that is not sa-lifecycle', async () => {
    const response = await app().call({ act_sub: ACTOR }, 'sa-provisioner@xaa-test.iam.gserviceaccount.com');
    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const { call } = app();
    const response = await call({ act_sub: ACTOR }, '');
    expect(response.status).toBe(403);
  });

  it('revokes and answers 200', async () => {
    const { call, ledger } = app();
    expect((await call({ act_sub: ACTOR })).status).toBe(200);
    expect(await ledger.isActorRevoked(ACTOR)).toBe(true);
  });

  it('is idempotent across two calls and never moves revoked_at', async () => {
    const { call, documents } = app();
    expect((await call({ act_sub: ACTOR })).status).toBe(200);
    const first = await documents.get<{ revoked_at: string }>('revoked_actors', revocationDocumentId(ACTOR));
    expect((await call({ act_sub: ACTOR })).status).toBe(200);
    const second = await documents.get<{ revoked_at: string }>('revoked_actors', revocationDocumentId(ACTOR));
    // A repeated Cleanup call must not push the cut-off forward: a token issued
    // between the two calls has to stay revoked.
    expect(second!.revoked_at).toBe(first!.revoked_at);
  });

  it('answers 200 for an actor it has never seen', async () => {
    const { call } = app();
    expect((await call({ act_sub: 'urn:xaa:agent:agent-zzzzzzzzzzzzzzzzzzzzzzzzzz' })).status).toBe(200);
  });

  it('rejects a body with any extra key', async () => {
    const { call } = app();
    expect((await call({ act_sub: ACTOR, force: true })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await call({ act_sub: 'agent-abcdefghijklmnopqrstuvwxyz' })).status).toBe(400);
  });
});
