import type { DocumentStore } from '@xaa/gcp';
import type { JsonStoreBackend, JsonStoreEntry } from '../oidc/store.js';

/**
 * Firestore implementation of the generated provider's JsonStoreBackend.
 *
 * Human IdP touches exactly four collections. The key prefix chooses one; a key
 * with an unknown prefix is a programming error and throws before any I/O. Every
 * resolved path also passes the shared access matrix inside DocumentStore, so a new
 * prefix cannot silently reach another app's data (DEV-05).
 */
export const IDP_COLLECTIONS = ['idp_transactions', 'idp_tokens', 'idp_sessions', 'idp_users'] as const;
export type IdpCollection = (typeof IDP_COLLECTIONS)[number];

const PREFIX_TO_COLLECTION: ReadonlyArray<readonly [string, IdpCollection]> = [
  ['transaction:', 'idp_transactions'],
  ['authorization-code:', 'idp_tokens'],
  ['access-token:', 'idp_tokens'],
  ['refresh-token:', 'idp_tokens'],
  ['auth-session:', 'idp_sessions'],
  ['browser-session:', 'idp_sessions'],
  ['consent:', 'idp_sessions'],
  ['user:', 'idp_users'],
];

export function collectionFor(key: string): IdpCollection {
  const found = PREFIX_TO_COLLECTION.find(([prefix]) => key.startsWith(prefix));
  if (!found) throw new Error(`unmapped store key prefix: ${key.split(':')[0] ?? key}`);
  return found[1];
}

interface StoredDocument {
  key: string;
  value: unknown;
  grant_id: string | null;
  revoked: boolean;
  expire_at: unknown;
}

/**
 * The whole key is encoded, so an access token and a refresh token that happen to
 * hold the same random value cannot collide inside the shared idp_tokens collection.
 */
function documentId(key: string): string {
  return encodeURIComponent(key);
}

function grantIdOf(value: unknown): string | null {
  const grantId = (value as { grantId?: unknown } | null)?.grantId;
  return typeof grantId === 'string' ? grantId : null;
}

/**
 * JsonStoreBackend values have JSON semantics, while the Firestore SDK rejects
 * `undefined` even when it is nested inside an otherwise valid object. Token
 * records contain optional claims, nonce and auth-context fields, so normalize
 * them exactly as JSON serialization would before handing them to Firestore.
 */
function normalizeJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('JSON store value is not serializable');
  return JSON.parse(serialized) as T;
}

export interface HumanIdpStoreBackend extends JsonStoreBackend {
  /** OAuth 2.1 §4.1.2: revoke the whole token family behind one authorization grant. */
  revokeByGrantId(grantId: string): Promise<number>;
}

export function createHumanIdpStoreBackend(store: DocumentStore, now: () => number = () => Date.now()): HumanIdpStoreBackend {
  const live = (document: StoredDocument | undefined): boolean => {
    if (document === undefined || document.revoked) return false;
    const expiresAt = store.toMillis(document.expire_at);
    return expiresAt === null || expiresAt > now();
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      const data = await store.get<StoredDocument>(collectionFor(key), documentId(key));
      return live(data) ? (data!.value as T) : null;
    },

    async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      const normalizedValue = normalizeJsonValue(value);
      await store.set(collectionFor(key), documentId(key), {
        key,
        value: normalizedValue,
        grant_id: grantIdOf(normalizedValue),
        revoked: false,
        expire_at: ttlSeconds === undefined ? null : store.expiryFromNow(ttlSeconds, now()),
      });
    },

    async delete(key: string): Promise<void> {
      await store.delete(collectionFor(key), documentId(key));
    },

    async list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>> {
      // The range is a query, not a post-filter: TTL deletion is asynchronous, so an
      // expired document can still be present and is dropped by `live` below.
      const rows = await store.queryRange<StoredDocument>(collectionFor(prefix), 'key', prefix, `${prefix}￿`);
      return rows.flatMap(({ data }) => (live(data) ? [{ key: data.key, value: data.value as T }] : []));
    },

    async revokeByGrantId(grantId: string): Promise<number> {
      const rows = await store.queryEqual<StoredDocument>('idp_tokens', [['grant_id', grantId]]);
      return store.updateMany('idp_tokens', rows.map((row) => row.id), { revoked: true });
    },
  };
}
