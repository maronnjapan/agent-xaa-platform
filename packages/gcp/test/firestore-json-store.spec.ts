import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '@xaa/crypto';
import { MAX_DOCUMENT_ID_BYTES } from '../src/document-id.js';
import { createFirestoreJsonStoreBackend, encodeKey } from '../src/firestore-json-store.js';
import { firestoreUnderTest } from '../src/testing/firestore-double.js';

/**
 * The Access Token `internal.finance.payment.approve` is redeemed for, at the size
 * production issues one: an RS256 JWT (2048-bit signature, 342 base64url characters)
 * carrying `act`, `cnf`, `isolation_level` and the approve tool's `xaa_constraints`,
 * signed by a Cloud Run issuer whose hostname is 60 characters.
 *
 * The access token store is keyed by the token itself, so this string is a store key
 * rather than a value — which is the whole problem. A docs token measures 1454-1474
 * bytes once encoded and fits; this one is the shape that does not.
 */
function approveAccessTokenKey(): string {
  const issuer = 'https://resource-finance-as-398229935889.asia-northeast1.run.app';
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid: 'fin-as-1a2b3c4d' }));
  const payload = encodeBase64Url(JSON.stringify({
    iss: issuer,
    sub: 'testuser',
    aud: [`${issuer}/userinfo`, 'https://resource-finance-api-398229935889.asia-northeast1.run.app'],
    exp: 1_800_000_300, iat: 1_800_000_000, jti: 'abcdefghijklmnop',
    scope: 'finance.tx.write', client_id: 'agent-platform',
    act: { sub: 'urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz' },
    cnf: { jkt: 'x'.repeat(43) },
    isolation_level: 'full_isolation',
    xaa_constraints: { max_amount: 1_000_000 },
  }));
  return `access-token:${header}.${payload}.${'s'.repeat(342)}`;
}

async function backend(collection: string) {
  const { firestore } = await firestoreUnderTest();
  return createFirestoreJsonStoreBackend({ firestore, collection });
}

describe('Firestore JsonStoreBackend', () => {
  it('put stores a value the next get returns', async () => {
    const store = await backend('oidc_human_idp');
    await store.put('transaction:one', { subject: 'user-1' });
    expect(await store.get('transaction:one')).toEqual({ subject: 'user-1' });
  });

  it('get answers null for a key that was never written', async () => {
    expect(await (await backend('oidc_human_idp')).get('transaction:absent')).toBeNull();
  });

  it('delete removes the entry', async () => {
    const store = await backend('oidc_human_idp');
    await store.put('transaction:one', { subject: 'user-1' });
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

  /**
   * The store is keyed by the Access Token, and base64url makes an id a third longer
   * than the key. Past Firestore's 1500-byte ceiling the write is refused, which at
   * the Resource AS reads as a 400 on a redemption that had already succeeded.
   */
  it('keeps an Access Token key inside the document id limit, and round-trips it', async () => {
    const key = approveAccessTokenKey();
    expect(encodeBase64Url(key).length).toBeGreaterThan(MAX_DOCUMENT_ID_BYTES);
    expect(encodeKey(key).length).toBeLessThanOrEqual(MAX_DOCUMENT_ID_BYTES);

    const store = await backend('oidc_resource_docs_as');
    await store.put(key, { sub: 'testuser', cnf_jkt: 'x'.repeat(43) });
    expect(await store.get(key)).toEqual({ sub: 'testuser', cnf_jkt: 'x'.repeat(43) });
    // `list` reads the stored `key` field, so it is indifferent to which form the id
    // took — that is what keeps revokeByGrantId working across the two.
    expect((await store.list('access-token:')).map((entry) => entry.key)).toEqual([key]);

    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it('leaves a key that already fits byte-identical, so written rows stay readable', () => {
    expect(encodeKey('transaction:one')).toBe(encodeBase64Url('transaction:one'));
  });
});
