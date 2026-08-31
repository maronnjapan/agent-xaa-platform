import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { collectionFor, createHumanIdpStoreBackend, IDP_COLLECTIONS } from '../src/store/firestore-backend.js';

function backend(now = () => Date.now()) {
  return createHumanIdpStoreBackend(createFirestoreDocumentStore(createFirestoreDouble(), 'human-idp'), now);
}

describe('human-idp Firestore backend', () => {
  it('denies write outside allowed prefixes', async () => {
    await expect(backend().put('agents/agent-x/meta', { a: 1 })).rejects.toThrow(/unmapped store key prefix/);
    expect(() => collectionFor('payments:1')).toThrow();
  });

  it('routes every generated prefix into one of four collections', () => {
    const used = new Set([
      'transaction:', 'authorization-code:', 'access-token:', 'refresh-token:',
      'auth-session:', 'browser-session:', 'consent:', 'user:',
    ].map((prefix) => collectionFor(`${prefix}x`)));
    expect([...used].sort()).toEqual([...IDP_COLLECTIONS].sort().filter((name) => used.has(name)));
    for (const collection of used) expect(IDP_COLLECTIONS).toContain(collection);
  });

  it('list skips expired entries', async () => {
    let clock = 1_000_000;
    const store = backend(() => clock);
    await store.put('access-token:live', { n: 1 }, 60);
    await store.put('access-token:dead', { n: 2 }, 10);
    clock += 30_000;
    expect((await store.list('access-token:')).map((entry) => entry.key)).toEqual(['access-token:live']);
    expect(await store.get('access-token:dead')).toBeNull();
  });

  it('list returns only prefix matches', async () => {
    const store = backend();
    await store.put('access-token:a', { n: 1 });
    await store.put('refresh-token:b', { n: 2 });
    expect((await store.list('access-token:')).map((entry) => entry.key)).toEqual(['access-token:a']);
  });

  it('revokeByGrantId hides every token of the grant', async () => {
    const store = backend();
    await store.put('access-token:a', { grantId: 'g1', n: 1 });
    await store.put('refresh-token:b', { grantId: 'g1', n: 2 });
    await store.put('access-token:c', { grantId: 'g2', n: 3 });
    expect(await store.revokeByGrantId('g1')).toBe(2);
    expect(await store.get('access-token:a')).toBeNull();
    expect(await store.get('refresh-token:b')).toBeNull();
    expect(await store.get('access-token:c')).not.toBeNull();
  });

  it('get put delete round trip', async () => {
    const store = backend();
    await store.put('user:testuser', { sub: 'testuser' });
    expect(await store.get('user:testuser')).toEqual({ sub: 'testuser' });
    await store.delete('user:testuser');
    expect(await store.get('user:testuser')).toBeNull();
  });
});
