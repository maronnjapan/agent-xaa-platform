import { Hono } from 'hono';
import { compile, SchemaValidationError } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';
import type { AuthorizationStore } from '../store/authorization-store.js';

export const permissionChangedSchema = {
  $id: 'human-permission-changed',
  type: 'object',
  additionalProperties: false,
  required: ['human_subject', 'capability_id', 'change'],
  properties: {
    human_subject: { type: 'string', minLength: 1 },
    capability_id: { type: 'string', minLength: 1 },
    change: { enum: ['grant', 'revoke'] },
  },
} as const;

interface PermissionChanged { human_subject: string; capability_id: string; change: 'grant' | 'revoke' }
const assertEvent: (value: unknown) => asserts value is PermissionChanged = compile<PermissionChanged>(permissionChangedSchema);

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
 * The proposal that produced the running agent already exists; asking a model again
 * could yield a different set for the same work, which would make a permission
 * revocation look like a re-scoping. Only the deterministic half re-runs.
 *
 * A widening (`grant`) deliberately does not reach a running agent: an agent's
 * authority is fixed when it is provisioned, and growing it in place would break
 * that. A narrowing (`revoke`) does, and asks Lifecycle to re-provision.
 */
export function createPermissionChangedRoute(deps: {
  store: AuthorizationStore;
  logger: Logger;
  clock: { now(): number };
  requestReprovision?: (agentId: string, reason: string) => Promise<void>;
}): Hono {
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
    const change = event as PermissionChanged;

    deps.logger.info('policy.permission_changed', {
      request_id: '', trace_id: '', agent_id: null, human_subject: change.human_subject,
    }, {
      capability_id: change.capability_id,
      change: change.change,
      // A grant is recorded and stops there; only a revocation propagates.
      propagated: change.change === 'revoke',
    });

    if (change.change === 'revoke') {
      await deps.requestReprovision?.(change.human_subject, 'human_permission_revoked');
    }
    return context.json({ accepted: true });
  });
  return app;
}
