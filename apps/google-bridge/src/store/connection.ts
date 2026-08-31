import { createHash } from 'node:crypto';
import type { DocumentStore } from '@xaa/gcp';
import type { Ciphertext } from './ciphertext.js';

export type ConnectionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface BridgeConnection {
  connection_id: string;
  connector_id: string;
  human_subject: string;
  external_subject: string;
  encrypted_refresh_token: Uint8Array;
  granted_scopes: string[];
  status: ConnectionStatus;
  created_at: string;
  expires_at: string;
}

/**
 * One connection per person per connector, guaranteed by the id rather than by a
 * constraint.
 *
 * Firestore has no unique indexes, so the uniqueness that `(connector_id,
 * human_subject)` would have had in a relational schema is expressed by deriving the
 * document id from exactly those two values. A random id would let a second consent
 * silently create a duplicate, and the second agent would then be reading a connection
 * nobody is refreshing.
 */
export function connectionId(connectorId: string, humanSubject: string): string {
  const digest = createHash('sha256').update(humanSubject, 'utf8').digest('hex').slice(0, 32);
  return `${connectorId}:${digest}`;
}

/** Sorted and deduplicated on write, so a subset check never depends on order. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

export interface ConnectionStore {
  find(connectionId: string): Promise<BridgeConnection | undefined>;
  upsert(input: {
    connectorId: string;
    humanSubject: string;
    externalSubject: string;
    refreshToken: Ciphertext;
    grantedScopes: string[];
    maxAgeSeconds: number;
    now?: number;
  }): Promise<BridgeConnection>;
  saveEncryptedRefreshToken(connectionId: string, value: Ciphertext): Promise<void>;
  setStatus(connectionId: string, status: ConnectionStatus): Promise<void>;
}

export function createConnectionStore(documents: DocumentStore): ConnectionStore {
  return {
    async find(id) {
      return documents.get<BridgeConnection>('bridge_connections', id);
    },
    async upsert(input) {
      const now = input.now ?? Date.now();
      const id = connectionId(input.connectorId, input.humanSubject);
      const existing = await documents.get<BridgeConnection>('bridge_connections', id);
      const connection: BridgeConnection = {
        connection_id: id,
        connector_id: input.connectorId,
        human_subject: input.humanSubject,
        external_subject: input.externalSubject,
        encrypted_refresh_token: input.refreshToken,
        // A second consent adds scopes rather than replacing them: the person granted
        // both sets, and dropping the earlier one would break agents already bound.
        granted_scopes: normalizeScopes([...(existing?.granted_scopes ?? []), ...input.grantedScopes]),
        status: 'ACTIVE',
        created_at: existing?.created_at ?? new Date(now).toISOString(),
        expires_at: new Date(now + input.maxAgeSeconds * 1000).toISOString(),
      };
      await documents.set('bridge_connections', id, connection as unknown as Record<string, unknown>);
      return connection;
    },
    /** Typed so only a KMS result can be written here. */
    async saveEncryptedRefreshToken(id, value) {
      await documents.update('bridge_connections', id, { encrypted_refresh_token: value });
    },
    async setStatus(id, status) {
      await documents.update('bridge_connections', id, { status });
    },
  };
}
