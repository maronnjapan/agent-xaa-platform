import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FirestoreJtiStore } from '../src/firestore-jti-store.js';
import { firestoreUnderTest } from '../src/testing/firestore-double.js';

describe('FirestoreJtiStore', () => {
  it('returns false on ALREADY_EXISTS', async () => {
    const { firestore } = await firestoreUnderTest();
    const store = new FirestoreJtiStore(firestore);
    const jti = randomUUID();
    await expect(store.consume('dpop', jti, 120)).resolves.toBe(true);
    await expect(store.consume('dpop', jti, 120)).resolves.toBe(false);
  });

  it('keeps namespaces isolated across the two collections', async () => {
    const { firestore } = await firestoreUnderTest();
    const store = new FirestoreJtiStore(firestore);
    const jti = randomUUID();
    await expect(store.consume('dpop', jti, 120)).resolves.toBe(true);
    await expect(store.consume('actor-token', jti, 360)).resolves.toBe(true);
    await expect(store.consume('client-assertion', jti, 360)).resolves.toBe(true);
    await expect(store.consume('actor-token', jti, 360)).resolves.toBe(false);
  });

  it('rejects a jti that cannot be a document id', async () => {
    const { firestore } = await firestoreUnderTest();
    const store = new FirestoreJtiStore(firestore);
    await expect(store.consume('dpop', 'a/b', 120)).rejects.toThrow();
    await expect(store.consume('dpop', '', 120)).rejects.toThrow();
  });
});
