import { Hono } from 'hono';
import { compile, SchemaValidationError } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';
import { claimPermissionChange } from '../reevaluate/idempotency.js';
import { reevaluate, type PermissionChange, type ReevaluateDeps } from '../reevaluate/reevaluate.js';

export const permissionChangedSchema = {
  $id: 'human-permission-changed',
  type: 'object',
  additionalProperties: false,
  // The subject and the moment are what the change *is*, and together they are the
  // idempotency key. Which capability moved is useful context, but the re-evaluation
  // recomputes everything the person may delegate, so it is not needed to act.
  required: ['human_subject', 'changed_at'],
  properties: {
    human_subject: { type: 'string', minLength: 1 },
    changed_at: { type: 'string', format: 'date-time' },
    capability_id: { type: 'string', minLength: 1 },
    action: { enum: ['grant', 'revoke'] },
  },
} as const;

const assertEvent: (value: unknown) => asserts value is PermissionChange = compile<PermissionChange>(permissionChangedSchema);

/** Pub/Sub wraps the payload in base64 under `message.data`. */
function unwrap(body: unknown): unknown {
  const message = (body as { message?: { data?: unknown } } | null)?.message;
  if (message && typeof message.data === 'string') {
    try { return JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')); } catch { return undefined; }
  }
  return body;
}

/**
 * REQ-03-022. A permission change re-runs the Policy Engine alone — never the AI.
 *
 * The response is 204 whether the change reached agents or not: the subscription is
 * telling this service something, not asking it for an answer, and a body would only
 * invite a caller to depend on what re-evaluation found. A failure is the one case
 * that returns 500, so Pub/Sub redelivers it.
 */
export function createPermissionChangedRoute(deps: ReevaluateDeps & { logger: Logger }): Hono {
  const app = new Hono();
  app.post('/', async (context) => {
    let event: unknown;
    try {
      event = unwrap(await context.req.json());
      assertEvent(event);
    } catch (error) {
      if (error instanceof SchemaValidationError || error instanceof SyntaxError) return context.json({ error: 'invalid_request' }, 400);
      throw error;
    }
    const change = event as PermissionChange;
    const receivedAt = new Date(deps.clock.now()).toISOString();

    if (await claimPermissionChange(deps.store, change, receivedAt) === 'duplicate') {
      deps.logger.info('policy.permission_changed', logContext(change.human_subject), {
        changed_at: change.changed_at, delivery: 'duplicate', agents_reevaluated: 0,
      });
      return context.body(null, 204);
    }

    const outcomes = await reevaluate(change, deps);
    deps.logger.info('policy.permission_changed', logContext(change.human_subject), {
      changed_at: change.changed_at,
      delivery: 'first',
      ...(change.capability_id ? { capability_id: change.capability_id } : {}),
      ...(change.action ? { action: change.action } : {}),
      agents_reevaluated: outcomes.length,
      changes: outcomes.map((outcome) => outcome.change),
      reprovision_requested: outcomes.filter((outcome) => outcome.reprovision_requested).length,
    });
    return context.body(null, 204);
  });
  return app;
}

function logContext(humanSubject: string) {
  return { request_id: '', trace_id: '', agent_id: null, human_subject: humanSubject };
}
