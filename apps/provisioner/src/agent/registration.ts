import { compile, type IsolationLevel } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

/**
 * docs 05 §3.4 / RULE-16 / RULE-46. What Agent OP is allowed to know about an agent.
 *
 * There is no `api_base_url`, no `tool_id` and no `issuer`/`subject`: Agent OP checks
 * audiences, resources and scopes, and never learns which API is behind them. The
 * schema refuses those keys rather than ignoring them.
 */
export const agentRegistrationSchema = {
  $id: 'provisioned-agent-registration',
  type: 'object',
  additionalProperties: false,
  required: ['agent_id', 'human_subject', 'client_auth', 'idp_connection_id', 'allowed_audiences', 'resources', 'scopes', 'trusted_resource_as', 'created_at', 'expires_at', 'status', 'dedicated_op', 'isolation_level', 'job_execution_name'],
  properties: {
    agent_id: { type: 'string', pattern: '^agent-[0-9a-z]{26}$' },
    human_subject: { type: 'string', minLength: 1 },
    client_auth: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'jwk_thumbprint', 'public_jwk'],
      properties: {
        method: { const: 'client_assertion_jwt' },
        jwk_thumbprint: { type: 'string', minLength: 1 },
        public_jwk: {
          type: 'object',
          additionalProperties: false,
          required: ['kty', 'crv', 'x', 'y'],
          // `d` is absent from the properties and additionalProperties is false, so a
          // private key cannot be written into a registration even by mistake.
          properties: {
            kty: { const: 'EC' }, crv: { const: 'P-256' },
            x: { type: 'string' }, y: { type: 'string' },
            kid: { type: 'string' }, alg: { const: 'ES256' }, use: { const: 'sig' },
          },
        },
      },
    },
    idp_connection_id: { type: 'string', minLength: 1 },
    allowed_audiences: { type: 'array', items: { type: 'string' } },
    resources: { type: 'array', items: { type: 'string' } },
    scopes: { type: 'array', items: { type: 'string' } },
    trusted_resource_as: { type: 'array', items: { type: 'string' } },
    created_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    // Provisioner writes only the first three; Lifecycle owns the rest (00b).
    status: { enum: ['CREATED', 'PROVISIONING', 'ACTIVE'] },
    dedicated_op: { type: ['string', 'null'] },
    isolation_level: { enum: ['standard', 'full_isolation'] },
    // Null until the job starts; the presence of a value is what makes a second
    // execution for the same agent a conflict rather than a retry (00b).
    job_execution_name: { type: ['string', 'null'] },
  },
} as const;

export interface ProvisionedRegistration {
  agent_id: string;
  human_subject: string;
  client_auth: { method: 'client_assertion_jwt'; jwk_thumbprint: string; public_jwk: Record<string, unknown> };
  idp_connection_id: string;
  allowed_audiences: string[];
  resources: string[];
  scopes: string[];
  trusted_resource_as: string[];
  created_at: string;
  expires_at: string;
  status: 'CREATED' | 'PROVISIONING' | 'ACTIVE';
  dedicated_op: string | null;
  isolation_level: IsolationLevel;
  job_execution_name: string | null;
}

const assertRegistration: (value: unknown) => asserts value is ProvisionedRegistration =
  compile<ProvisionedRegistration>(agentRegistrationSchema);

export class AgentAlreadyExists extends Error {
  constructor(readonly agentId: string) { super('agent_already_exists'); }
}

/**
 * RULE-03 / RULE-31. Every agent gets its own registration, its own key and its own
 * IdP connection, whatever its isolation level. STANDARD shares one Cloud Run
 * process; it does not share an identity.
 */
export async function createAgentRegistration(documents: DocumentStore, registration: ProvisionedRegistration): Promise<void> {
  assertRegistration(registration);
  const existing = await documents.get('agents', `${registration.agent_id}__meta`);
  if (existing !== undefined) throw new AgentAlreadyExists(registration.agent_id);
  await documents.set('agents', `${registration.agent_id}__meta`, { ...registration });
}

/** Provisioner writes exactly these three; anything else belongs to Lifecycle. */
export async function setProvisioningStatus(
  documents: DocumentStore, agentId: string, status: 'CREATED' | 'PROVISIONING' | 'ACTIVE',
): Promise<void> {
  await documents.update('agents', `${agentId}__meta`, { status });
}

export async function deleteAgentRegistration(documents: DocumentStore, agentId: string): Promise<void> {
  await documents.delete('agents', `${agentId}__meta`);
}
