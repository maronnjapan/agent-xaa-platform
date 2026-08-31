import type { DocumentStore } from '@xaa/gcp';
import type { AgentRegistration } from './types.js';

/** Read-only: Agent OP never writes a registration. Provisioner and Lifecycle do. */
export class AgentRegistrationRepository {
  constructor(private readonly store: DocumentStore) {}
  async find(agentId: string): Promise<AgentRegistration | undefined> {
    return this.store.get<AgentRegistration>('agents', `${agentId}__meta`);
  }
}
