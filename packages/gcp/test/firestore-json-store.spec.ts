import { describe, expect, it } from 'vitest';
import { createFirestoreJsonStoreBackend, encodeKey } from '../src/firestore-json-store.js';
import { firestoreUnderTest } from '../src/testing/firestore-double.js';

async function backend(collection: string) {
  const { firestore } = await firestoreUnderTest();
  return createFirestoreJsonStoreBackend({ firestore, collection });
}

describe('Firestore JsonStoreBackend', () => {
  it('get put delete round trip', async () => {
    const store = await backend('oidc_human_idp');
    await store.put('transaction:one', { subject: 'user-1' });
    expect(await store.get('transaction:one')).toEqual({ subject: 'user-1' });
    await store.delete('transaction:one');
    expect(await store.get('transaction:one')).toBeNull();
  });

  it('list returns only prefix matches', async () => {
    const store = await backend('oidc_resource_docs_as');
    await store.put('transaction:a', { n: 1 });
    await store.put('transaction:b', { n: 2 });
    await store.put('access-token:c', { n: 3 });
    const listed = await store.list('transaction:');
    expect(listed.map((entry) => entry.key).sort()).toEqual(['transaction:a', 'transaction:b']);
  });

  it('expired entry reads as null', async () => {
    const store = await backend('oidc_resource_finance_as');
    await store.put('access-token:expired', { n: 1 }, -1);
    expect(await store.get('access-token:expired')).toBeNull();
    expect(await store.list('access-token:')).toEqual([]);
  });

  it('encodes keys so slashes never reach the document id', () => {
    const encoded = encodeKey('session/abc');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});
