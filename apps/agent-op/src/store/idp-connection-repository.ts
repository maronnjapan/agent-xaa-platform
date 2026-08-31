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
}
