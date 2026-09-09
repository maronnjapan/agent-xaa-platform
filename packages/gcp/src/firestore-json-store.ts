import { createHash } from 'node:crypto';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { encodeBase64Url } from '@xaa/crypto';
import { MAX_DOCUMENT_ID_BYTES } from './document-id.js';
import type { JsonStoreBackend } from './json-store-backend.js';

export const OIDC_STORE_COLLECTIONS = ['oidc_human_idp', 'oidc_resource_docs_as', 'oidc_resource_finance_as', 'oidc_stub_saas_op'] as const;

/**
 * The document id for a store key.
 *
 * Base64url while it fits: a readable id is worth having, and every row already
 * written carries one. Past Firestore's ceiling the id becomes a hash instead,
 * because some of these keys are tokens rather than identifiers — the access token
 * store is keyed by the Access Token itself, and an RS256 token carrying `act`,
 * `cnf` and constraints encodes to more than 1500 bytes. Firestore refuses that
 * write, and at the Resource AS the refusal surfaces as a 400 on a redemption that
 * had already succeeded.
 *
 * `~` is outside the base64url alphabet, so a hashed id can never collide with an
 * encoded one. The plaintext key is stored in the row's `key` field either way, so
 * `list` is unaffected by which form the id took.
 */
export function encodeKey(key: string): string {
  const encoded = encodeBase64Url(key.replaceAll('/', '__'));
  // base64url is ASCII, so its length is its byte length.
  if (encoded.length <= MAX_DOCUMENT_ID_BYTES) return encoded;
  return `sha256~${createHash('sha256').update(key, 'utf8').digest('base64url')}`;
}

export function createFirestoreJsonStoreBackend(options: { firestore: Firestore; collection: string }): JsonStoreBackend {
  const collection = options.firestore.collection(options.collection);
  return {
    async get(key) {
      const snapshot = await collection.doc(encodeKey(key)).get();
      if (!snapshot.exists) return null;
      const data = snapshot.data()!;
      const expiresAt = data.expireAt as Timestamp | null | undefined;
      if (expiresAt && expiresAt.toMillis() <= Date.now()) return null;
      return data.value as never;
    },
    async put(key, value, ttlSeconds) {
      await collection.doc(encodeKey(key)).set({
        key,
        value,
        expireAt: ttlSeconds === undefined ? null : Timestamp.fromMillis(Date.now() + ttlSeconds * 1000),
      });
    },
    async delete(key) { await collection.doc(encodeKey(key)).delete(); },
    async list(prefix) {
      const snapshot = await collection.where('key', '>=', prefix).where('key', '<', `${prefix}\uf8ff`).get();
      const now = Date.now();
      return snapshot.docs.flatMap((document) => {
        const data = document.data();
        const expiresAt = data.expireAt as Timestamp | null | undefined;
        return expiresAt && expiresAt.toMillis() <= now ? [] : [{ key: data.key as string, value: data.value as never }];
      });
    },
  };
}
