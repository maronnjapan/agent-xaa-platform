import { compile } from '@xaa/contracts';
import { businessWorkRequestSchema, BUSINESS_WORK_REQUEST_KEYS } from '../schemas/index.js';
import type { ControlPlaneClient } from '../http/control-plane-client.js';
import type { WorkDefinition } from './model.js';

export interface BusinessWorkRequest {
  human_subject: string;
  purpose: string;
  description: string;
  constraints: Record<string, boolean>;
  requested_lifetime_hours: number;
}

const assertRequest: (value: unknown) => asserts value is BusinessWorkRequest =
  compile<BusinessWorkRequest>(businessWorkRequestSchema);

export class WorkDefinitionNotConfirmed extends Error {
  readonly code = 'work_definition_not_confirmed';
}

/**
 * What the Authorization Platform is told, and what it is not.
 *
 * Five keys, all of them business language: what the person wants done, under what
 * self-declared constraints, for how long. No capability, no scope, no audience, no
 * tool id — RULE-07 puts the translation from work to permission on the other side of
 * this call, and the only way to keep it there is for this app never to have the
 * vocabulary. The schema's `additionalProperties: false` makes an accidental sixth key
 * a local failure rather than a leak.
 */
export function buildBusinessWorkRequest(definition: WorkDefinition): BusinessWorkRequest {
  if (definition.status !== 'CONFIRMED') throw new WorkDefinitionNotConfirmed();
  return {
    human_subject: definition.human_subject,
    purpose: definition.purpose,
    description: definition.description,
    // Declared by the person, in their own terms. `external_message_send` is always
    // present so its absence never reads as "not considered".
    constraints: { external_message_send: definition.operations.some((operation) => operation.includes('送信')) },
    requested_lifetime_hours: definition.requested_lifetime_hours,
  };
}

export async function submitBusinessWorkRequest(input: {
  definition: WorkDefinition;
  client: ControlPlaneClient;
  authorizationPlatformUrl: string;
}): Promise<Response> {
  const body = buildBusinessWorkRequest(input.definition);
  assertRequest(body);
  if (Object.keys(body).length !== BUSINESS_WORK_REQUEST_KEYS.length) throw new Error('unexpected work request shape');
  return input.client.send('authorization-platform', {
    url: new URL('/api/work-requests', input.authorizationPlatformUrl).toString(),
    method: 'POST',
    body,
    requiredScope: 'workdef:submit',
  });
}
