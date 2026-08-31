import type { DocumentStore } from '@xaa/gcp';
import type { AgentRegistration, XaaStaticConfiguration } from './types.js';

/**
 * The static XAA configuration is a projection of the registration document
 * (00b: the `xaa_configs` collection is not created). Keeping it behind its own
 * repository preserves the type separation docs 05 §3.4 asks for.
 */
export class XaaConfigRepository {
  constructor(private readonly store: DocumentStore) {}

  async find(agentId: string): Promise<XaaStaticConfiguration | undefined> {
    const document = await this.store.get<AgentRegistration & {
      allowed_audiences?: string[]; resources?: string[]; scopes?: string[]; trusted_resource_as?: string[];
    }>('agents', `${agentId}__meta`);
    return document ? toXaaConfig(document) : undefined;
  }
}

export function toXaaConfig(registration: AgentRegistration & {
  allowed_audiences?: string[]; resources?: string[]; scopes?: string[]; trusted_resource_as?: string[];
}): XaaStaticConfiguration {
  return {
    agent_id: registration.agent_id,
    // Empty arrays, never undefined: validateIdJagScope treats undefined as
    // "anything goes", which would silently disable the check (T-OP-20).
    allowed_audiences: registration.allowed_audiences ?? [],
    resources: registration.resources ?? [],
    scopes: registration.scopes ?? [],
    trusted_resource_as: registration.trusted_resource_as ?? [],
    expires_at: registration.expires_at,
  };
}
