import { xaaStaticConfigSchema } from './xaa-static-config.schema.js';

export const AGENT_STATUSES = ['CREATED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED'] as const;

export const agentRegistrationSchema = {
  $id: 'agent-registration',
  type: 'object',
  additionalProperties: false,
  required: ['agent_id', 'human_subject', 'status', 'expires_at', 'isolation_level', 'dedicated_op', 'client_auth', 'xaa_static_config'],
  properties: {
    agent_id: { type: 'string', pattern: '^agent-[0-9a-z]{26}$' },
    human_subject: { type: 'string', minLength: 1 },
    status: { enum: AGENT_STATUSES },
    expires_at: { type: 'string', format: 'date-time' },
    isolation_level: { enum: ['standard', 'full_isolation'] },
    dedicated_op: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', format: 'uri' } } }] },
    client_auth: { type: 'object', additionalProperties: false, required: ['jwk_thumbprint', 'public_jwk'], properties: { jwk_thumbprint: { type: 'string', minLength: 1 }, public_jwk: { type: 'object' } } },
    xaa_static_config: xaaStaticConfigSchema,
  },
} as const;
