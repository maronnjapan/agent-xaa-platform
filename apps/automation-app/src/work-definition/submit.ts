import { compile } from '@xaa/contracts';
import { businessWorkRequestSchema, BUSINESS_WORK_REQUEST_KEYS } from '../schemas/index.js';
import type { ControlPlaneClient } from '../http/control-plane-client.js';
import type { WorkDefinition } from './model.js';

export interface BusinessWorkRequest {
  human_subject: string;
  purpose: string;
  description: string;
  constraints: Record<string, boolean>;
  requested_lifetime_minutes: number;
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
    // The ToDo's title is the work's purpose, in the person's words.
    purpose: definition.title,
    description: definition.description,
    // Declared by the person, in their own terms. `external_message_send` is always
    // present so its absence never reads as "not considered".
    constraints: { external_message_send: mentionsSending(definition) },
    requested_lifetime_minutes: definition.requested_lifetime_minutes,
  };
}

/** Whether the person's own words say something is to be sent out. */
function mentionsSending(definition: WorkDefinition): boolean {
  return [definition.title, definition.description, ...definition.steps].some((line) => line.includes('送信'));
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

/** The two ways this app answers when the decision it asked for did not come back. */
export interface UpstreamRefusal {
  status: 400 | 502;
  body: { error: string };
}

/**
 * A refusal the Authorization Platform made, told apart from one nobody made.
 *
 * The platform states a refusal it decided on as `{ error: <code> }` with a 400: the
 * request was read and turned down on its merits, so the person is the one who can act
 * on it and the code travels to the screen unchanged.
 *
 * Everything else means no decision was reached — the far end was down, the body was not
 * JSON, or the Google front end answered 404 because the service takes no ingress from
 * here. Forwarding that status made this app say 404, which is what it says from every
 * other route when the person's own record is missing; the reader then goes looking for
 * a work definition that was never the problem. One name for "the call did not land" is
 * what keeps the screen from blaming the wrong thing.
 */
export function upstreamRefusal(status: number, body: { error?: unknown }): UpstreamRefusal {
  if (status === 400 && typeof body.error === 'string') return { status: 400, body: { error: body.error } };
  return { status: 502, body: { error: 'authorization_platform_unreachable' } };
}

/**
 * What the Authorization Platform actually answered, kept where a person can read it.
 *
 * One name on the screen is right — the person cannot act on `invalid_token` any more
 * than on `insufficient_scope`, and both mean the same thing to them: the decision they
 * asked for was not made. But one name is not enough for whoever has to fix it, and
 * until now nothing anywhere recorded the difference. A stale aggregate JWKS (401), a
 * missing `roles/run.invoker` (403 at the Google front end), an ingress that drops the
 * call (404) and a decision that threw (500) all reached the screen as the same
 * sentence, with nothing behind it to tell them apart.
 *
 * The status and the upstream code are enough to tell them apart, and neither is a
 * credential. The Access Token is not a field here and must not become one.
 */
export function logUpstreamRefusal(
  failure: { work_definition_id: string; human_subject: string; status: number; error: string },
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  write(`${JSON.stringify({
    severity: 'ERROR',
    logType: 'xaa.authorization_platform_refused',
    ...failure,
    occurred_at: new Date().toISOString(),
  })}\n`);
}
