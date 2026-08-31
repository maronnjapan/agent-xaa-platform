import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { encodeBase64Url } from '@xaa/crypto';
import type { JsonStoreBackend } from './json-store-backend.js';

export const OIDC_STORE_COLLECTIONS = ['oidc_human_idp', 'oidc_resource_docs_as', 'oidc_resource_finance_as', 'oidc_stub_saas_op'] as const;

export function encodeKey(key: string): string {
  return encodeBase64Url(key.replaceAll('/', '__'));
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
