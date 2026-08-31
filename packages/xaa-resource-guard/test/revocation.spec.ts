import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createRevocationLedger, revocationDocumentId } from '../src/revocation.js';

const ACTOR = 'urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz';

function ledger(now = () => Date.now()) {
  return createRevocationLedger(createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api'), now);
}

describe('actor revocation ledger', () => {
  it('reports an unknown actor as active', async () => {
    expect(await ledger().isActorRevoked(ACTOR)).toBe(false);
  });

  it('reports a revoked actor after the cache window', async () => {
    let clock = 1_000_000;
    const store = ledger(() => clock);
    expect(await store.isActorRevoked(ACTOR)).toBe(false);
    await store.revoke(ACTOR);
    clock += 11_000;
    expect(await store.isActorRevoked(ACTOR)).toBe(true);
  });

  it('is idempotent and keeps the first revoked_at', async () => {
    let clock = 1_000_000;
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api');
    const store = createRevocationLedger(documents, () => clock);
    await store.revoke(ACTOR);
    const first = await documents.get<{ revoked_at: string }>('revoked_actors', revocationDocumentId(ACTOR));
    clock += 60_000;
    await store.revoke(ACTOR);
    const second = await documents.get<{ revoked_at: string }>('revoked_actors', revocationDocumentId(ACTOR));
    expect(second!.revoked_at).toBe(first!.revoked_at);
  });

  it('encodes the urn into a legal document id', () => {
    const id = revocationDocumentId(ACTOR);
    expect(id).not.toContain(':');
    expect(id).not.toContain('/');
    expect(Buffer.from(id, 'base64url').toString('utf8')).toBe(ACTOR);
  });

  it('picks up another instance\'s revocation only after the cache window', async () => {
    let clock = 1_000_000;
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api');
    const store = createRevocationLedger(documents, () => clock);
    expect(await store.isActorRevoked(ACTOR)).toBe(false);
    // Written by a different Cloud Run instance, so this one's cache is untouched.
    await documents.set('revoked_actors', revocationDocumentId(ACTOR), {
      act_sub: ACTOR, revoked_at: new Date(clock).toISOString(),
    });
    clock += 9_000;
    expect(await store.isActorRevoked(ACTOR)).toBe(false);
    clock += 2_000;
    expect(await store.isActorRevoked(ACTOR)).toBe(true);
  });

  it('takes effect at once for the instance that performed the revocation', async () => {
    const store = ledger();
    expect(await store.isActorRevoked(ACTOR)).toBe(false);
    await store.revoke(ACTOR);
    expect(await store.isActorRevoked(ACTOR)).toBe(true);
  });
});
