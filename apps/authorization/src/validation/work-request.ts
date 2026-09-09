import { compile, findAuthorizationInputFields, SchemaValidationError } from '@xaa/contracts';

export interface BusinessWorkRequest {
  human_subject?: string;
  purpose: string;
  description: string;
  constraints?: { external_message_send?: boolean };
  requested_lifetime_minutes: number;
}

export const businessWorkRequestSchema = {
  $id: 'business-work-request',
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'description', 'requested_lifetime_minutes'],
  properties: {
    human_subject: { type: 'string', minLength: 1 },
    purpose: { type: 'string', minLength: 1, maxLength: 500 },
    description: { type: 'string', minLength: 1, maxLength: 5000 },
    constraints: {
      type: 'object',
      additionalProperties: false,
      properties: { external_message_send: { type: 'boolean' } },
    },
    requested_lifetime_minutes: { type: 'integer', minimum: 1 },
  },
} as const;

const assertShape: (value: unknown) => asserts value is BusinessWorkRequest = compile<BusinessWorkRequest>(businessWorkRequestSchema);

export type WorkRequestError = 'authorization_field_not_allowed' | 'unexpected_field' | 'invalid_request';

export class WorkRequestRejected extends Error {
  constructor(readonly code: WorkRequestError) { super(code); }
}

/**
 * RULE-07, enforced where the request arrives.
 *
 * The permission check runs first and on purpose: a body carrying both an unknown
 * field and `effective_capabilities` must always answer
 * `authorization_field_not_allowed`, so the caller learns the real objection rather
 * than a schema quibble. Automation App does not decide permissions, and a request
 * that tries to is refused rather than quietly sanitised.
 */
export function validateWorkRequest(body: unknown, maxLifetimeMinutes: number): BusinessWorkRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkRequestRejected('invalid_request');
  if (findAuthorizationInputFields(body as Record<string, unknown>).length > 0) {
    throw new WorkRequestRejected('authorization_field_not_allowed');
  }
  const unknownField = Object.keys(body as Record<string, unknown>)
    .some((key) => !(key in businessWorkRequestSchema.properties));
  try {
    assertShape(body);
  } catch (error) {
    if (!(error instanceof SchemaValidationError)) throw error;
    throw new WorkRequestRejected(unknownField ? 'unexpected_field' : 'invalid_request');
  }
  if ((body as BusinessWorkRequest).requested_lifetime_minutes > maxLifetimeMinutes) {
    throw new WorkRequestRejected('invalid_request');
  }
  return body as BusinessWorkRequest;
}
