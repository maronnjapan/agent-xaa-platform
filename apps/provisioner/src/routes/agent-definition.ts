import { compile, findAuthorizationInputFields, SchemaValidationError } from '@xaa/contracts';

export interface AgentDefinition {
  decision_id: string;
  human_subject?: string;
  task_id: string;
  requested_lifetime_hours: number;
}

export const agentDefinitionSchema = {
  $id: 'agent-definition',
  type: 'object',
  additionalProperties: false,
  required: ['decision_id', 'task_id', 'requested_lifetime_hours'],
  properties: {
    decision_id: { type: 'string', pattern: '^dec_[0-9a-f-]{36}$' },
    human_subject: { type: 'string', minLength: 1 },
    task_id: { type: 'string', minLength: 1, maxLength: 128 },
    requested_lifetime_hours: { type: 'integer', minimum: 1 },
  },
} as const;

const assertDefinition: (value: unknown) => asserts value is AgentDefinition = compile<AgentDefinition>(agentDefinitionSchema);

export type DefinitionError = 'authorization_field_not_allowed' | 'unexpected_field' | 'invalid_request';

export class DefinitionRejected extends Error {
  constructor(readonly code: DefinitionError) { super(code); }
}

/**
 * RULE-07 again, on the provisioning side. Automation App names a decision; it does
 * not name capabilities. The same forbidden-field list guards both entry points, so
 * closing one and forgetting the other is not possible.
 */
export function validateAgentDefinition(body: unknown, maxLifetimeHours: number): AgentDefinition {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DefinitionRejected('invalid_request');
  if (findAuthorizationInputFields(body as Record<string, unknown>).length > 0) {
    throw new DefinitionRejected('authorization_field_not_allowed');
  }
  const unknownField = Object.keys(body as Record<string, unknown>)
    .some((key) => !(key in agentDefinitionSchema.properties));
  try {
    assertDefinition(body);
  } catch (error) {
    if (!(error instanceof SchemaValidationError)) throw error;
    throw new DefinitionRejected(unknownField ? 'unexpected_field' : 'invalid_request');
  }
  if ((body as AgentDefinition).requested_lifetime_hours > maxLifetimeHours) throw new DefinitionRejected('invalid_request');
  return body as AgentDefinition;
}
