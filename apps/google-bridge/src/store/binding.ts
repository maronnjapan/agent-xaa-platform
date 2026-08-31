import type { DocumentStore } from '@xaa/gcp';
import { BridgeError } from '../errors.js';
import { normalizeScopes } from './connection.js';

export type BindingStatus = 'ACTIVE' | 'DISABLED';

export interface AgentBinding {
  binding_id: string;
  agent_id: string;
  connector_id: string;
  connection_id: string;
  human_subject: string;
  scopes: string[];
  status: BindingStatus;
  created_at: string;
  expires_at: string;
}

/** `(agent_id, connector_id)` as an id: the uniqueness constraint, expressed as a key. */
export function bindingId(agentId: string, connectorId: string): string {
  return `${agentId}:${connectorId}`;
}

export interface BindingStore {
  find(agentId: string, connectorId: string): Promise<AgentBinding | undefined>;
  create(input: Omit<AgentBinding, 'binding_id' | 'status' | 'created_at'> & { now?: number }): Promise<AgentBinding>;
  disableAll(agentId: string): Promise<number>;
  deleteAll(agentId: string): Promise<number>;
}

export function createBindingStore(documents: DocumentStore): BindingStore {
  const forAgent = async (agentId: string): Promise<Array<{ id: string }>> =>
    // A range over the id prefix, not a full scan: the id starts with the agent id
    // precisely so this query exists.
    documents.queryRange('agent_bindings', 'agent_id', agentId, `${agentId}￿`);

  return {
    async find(agentId, connectorId) {
      return documents.get<AgentBinding>('agent_bindings', bindingId(agentId, connectorId));
    },
    async create(input) {
      const now = input.now ?? Date.now();
      const binding: AgentBinding = {
        binding_id: bindingId(input.agent_id, input.connector_id),
        agent_id: input.agent_id,
        connector_id: input.connector_id,
        connection_id: input.connection_id,
        human_subject: input.human_subject,
        scopes: normalizeScopes(input.scopes),
        status: 'ACTIVE',
        created_at: new Date(now).toISOString(),
        expires_at: input.expires_at,
      };
      try {
        // `create`, never `set`: a second binding for the same agent and connector is a
        // mistake worth reporting, not a silent overwrite of the first one's scopes.
        await documents.create('agent_bindings', binding.binding_id, binding as unknown as Record<string, unknown>);
      } catch (error) {
        if ((error as { code?: number }).code === 6) throw new BridgeError('binding_already_exists', 400);
        throw error;
      }
      return binding;
    },
    async disableAll(agentId) {
      const rows = await forAgent(agentId);
      for (const row of rows) await documents.update('agent_bindings', row.id, { status: 'DISABLED' });
      return rows.length;
    },
    async deleteAll(agentId) {
      const rows = await forAgent(agentId);
      // The connection is untouched: it belongs to the person, not to this agent, and
      // other agents may still be bound to it.
      for (const row of rows) await documents.delete('agent_bindings', row.id);
      return rows.length;
    },
  };
}
