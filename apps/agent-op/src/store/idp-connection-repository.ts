import type { DocumentStore } from '@xaa/gcp';
import type { IdpConnection } from './types.js';

/** The one collection Agent OP writes to. */
export class IdpConnectionRepository {
  constructor(private readonly store: DocumentStore) {}

  async find(idpConnectionId: string): Promise<IdpConnection | undefined> {
    return this.store.get<IdpConnection>('idp_connections', idpConnectionId);
  }

  async findByAgent(agentId: string): Promise<IdpConnection | undefined> {
    const rows = await this.store.queryEqual<IdpConnection>('idp_connections', [['agent_id', agentId]], 1);
    return rows[0]?.data;
  }

  async create(connection: IdpConnection): Promise<void> {
    await this.store.set('idp_connections', connection.idp_connection_id, { ...connection });
  }

  async update(idpConnectionId: string, patch: Partial<IdpConnection>): Promise<void> {
    await this.store.update('idp_connections', idpConnectionId, { ...patch });
  }

  /**
   * Ends the connection and drops the credential with it. `update` merges, so a field
   * cannot be cleared that way: the document is rewritten without
   * `encrypted_refresh_token`. Called only once Human IdP has accepted the token back
   * — while a revocation is still owed upstream, the ciphertext is what a retry
   * spends (RULE-22).
   */
  async revokeAndForgetToken(idpConnectionId: string): Promise<void> {
    const existing = await this.find(idpConnectionId);
    if (!existing) return;
    const rest: Record<string, unknown> = { ...existing };
    delete rest.encrypted_refresh_token;
    await this.store.set('idp_connections', idpConnectionId, { ...rest, status: 'REVOKED' });
  }
}
