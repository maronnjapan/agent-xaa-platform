import type { DocumentStore } from '@xaa/gcp';

export const REVOKED_ACTORS_COLLECTION = 'revoked_actors';
const CACHE_TTL_MS = 10_000;

/** `act.sub` is a URN with characters Firestore rejects in a document id. */
export function revocationDocumentId(actorUrn: string): string {
  return Buffer.from(actorUrn, 'utf8').toString('base64url');
}

export interface RevocationLedger {
  /**
   * Records the agent as revoked. Idempotent: a second call keeps the original
   * `revoked_at` so a repeated Cleanup cannot move the cut-off forward.
   */
  revoke(actorUrn: string): Promise<void>;
  /**
   * True once the agent appears in the ledger. Revocation is absolute: a token
   * issued after it cannot legitimately exist, because the Authorization Server
   * consults the same ledger before issuing. `tokenIssuedAt` is accepted so a
   * caller can report how stale the token was, and never to soften the answer.
   */
  isActorRevoked(actorUrn: string, tokenIssuedAt?: number): Promise<boolean>;
}

/**
 * One ledger shared by both resource families (T-RES-22): an agent revoked for
 * documents is revoked for payments too. Only a Resource API writes to it; the
 * two Authorization Servers read it.
 */
export function createRevocationLedger(store: DocumentStore, now: () => number = () => Date.now()): RevocationLedger {
  const cache = new Map<string, { revokedAt: number | null; readAt: number }>();

  const read = async (actorUrn: string): Promise<number | null> => {
    const cached = cache.get(actorUrn);
    if (cached && now() - cached.readAt < CACHE_TTL_MS) return cached.revokedAt;
    const record = await store.get<{ revoked_at?: unknown }>(REVOKED_ACTORS_COLLECTION, revocationDocumentId(actorUrn));
    const revokedAt = record === undefined ? null : store.toMillis(record.revoked_at) ?? now();
    cache.set(actorUrn, { revokedAt, readAt: now() });
    return revokedAt;
  };

  return {
    async revoke(actorUrn) {
      const id = revocationDocumentId(actorUrn);
      const existing = await store.get(REVOKED_ACTORS_COLLECTION, id);
      if (existing !== undefined) return;
      await store.set(REVOKED_ACTORS_COLLECTION, id, {
        act_sub: actorUrn,
        revoked_at: new Date(now()).toISOString(),
      });
      cache.delete(actorUrn);
    },

    async isActorRevoked(actorUrn, _tokenIssuedAt) {
      void _tokenIssuedAt;
      return (await read(actorUrn)) !== null;
    },
  };
}
