import { AGENT_URN_PREFIX } from '@xaa/contracts';
import { BridgeError } from '../errors.js';
import type { VerifiedIdJag } from '../dpop/cnf-binding.js';
import type { AgentBinding, BindingStore } from '../store/binding.js';
import type { BridgeConnection, ConnectionStore } from '../store/connection.js';
import type { ConnectorRegistry } from '../connectors/registry.js';

export interface ResolvedBinding {
  agentId: string;
  connectorId: string;
  binding: AgentBinding;
  connection: BridgeConnection;
  effectiveExpiry: number;
}

export type ValidationSink = (validation: 'invalid_bridge_binding' | 'expired_bridge_connection', fields: Record<string, unknown>) => void;

/**
 * Five conditions, in a fixed order, before anything is sent to the SaaS.
 *
 * The order matters less than the fact that all of it happens first: this function
 * returns before a single outbound call is made, so every refusal below costs the
 * external service nothing and tells an attacker nothing about which agents exist.
 *
 * The effective expiry is the earliest of the binding's, the connection's and the
 * ID-JAG's. The last of those is already capped at the agent's own lifetime (DEC-ID-09),
 * so the Bridge never needs to look the agent up — and cannot disagree with the OP
 * about how long it has left.
 */
export async function resolveBinding(input: {
  verified: VerifiedIdJag;
  bindings: BindingStore;
  connections: ConnectionStore;
  connectors: ConnectorRegistry;
  now: Date;
  onValidation?: ValidationSink;
}): Promise<ResolvedBinding> {
  const { verified } = input;
  if (!verified.actSub.startsWith(AGENT_URN_PREFIX)) {
    input.onValidation?.('invalid_bridge_binding', { reason: 'missing_act' });
    throw new BridgeError('invalid_grant', 400);
  }
  const agentId = verified.actSub.slice(AGENT_URN_PREFIX.length);
  const connector = await input.connectors.findConnectorByResource(verified.resource);

  const binding = await input.bindings.find(agentId, connector.connector_id);
  if (!binding) {
    input.onValidation?.('invalid_bridge_binding', { agent_id: agentId, reason: 'no_binding' });
    throw new BridgeError('invalid_grant', 400);
  }
  if (binding.status !== 'ACTIVE') {
    input.onValidation?.('invalid_bridge_binding', { agent_id: agentId, reason: 'binding_disabled' });
    throw new BridgeError('invalid_grant', 400);
  }
  const nowMs = input.now.getTime();
  if (Date.parse(binding.expires_at) <= nowMs) {
    input.onValidation?.('expired_bridge_connection', {
      agent_id: agentId, connection_id: binding.connection_id,
      binding_expires_at: binding.expires_at, connection_expires_at: null,
    });
    throw new BridgeError('invalid_grant', 400);
  }
  if (binding.human_subject !== verified.sub) {
    // The binding says this agent acts for someone else. RULE-46: the delegation chain
    // has to agree end to end, or an agent could reach a colleague's mailbox.
    input.onValidation?.('invalid_bridge_binding', { agent_id: agentId, reason: 'human_subject_mismatch' });
    throw new BridgeError('invalid_grant', 400);
  }

  const connection = await input.connections.find(binding.connection_id);
  if (!connection || connection.status !== 'ACTIVE') {
    input.onValidation?.('invalid_bridge_binding', { agent_id: agentId, reason: 'connection_not_active' });
    throw new BridgeError('invalid_grant', 400);
  }
  if (Date.parse(connection.expires_at) <= nowMs) {
    input.onValidation?.('expired_bridge_connection', {
      agent_id: agentId, connection_id: connection.connection_id,
      binding_expires_at: binding.expires_at, connection_expires_at: connection.expires_at,
    });
    throw new BridgeError('invalid_grant', 400);
  }

  return {
    agentId,
    connectorId: connector.connector_id,
    binding,
    connection,
    effectiveExpiry: Math.min(Date.parse(binding.expires_at), Date.parse(connection.expires_at), verified.exp * 1000),
  };
}
