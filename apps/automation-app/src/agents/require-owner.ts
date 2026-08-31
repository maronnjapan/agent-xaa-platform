import type { MiddlewareHandler } from 'hono';
import type { DocumentStore } from '@xaa/gcp';
import { logAgentOperation, type AuditOperation } from '../audit/logger.js';
import type { UserVariables } from '../auth/require-user.js';

export interface AgentOwnerVariables {
  Variables: UserVariables['Variables'] & { agentId: string };
}

const OPERATION_BY_METHOD: Record<string, AuditOperation> = {
  GET: 'status_read', POST: 'stop', PUT: 'stop', PATCH: 'stop',
};

function operationFor(method: string, path: string): AuditOperation {
  if (path.endsWith('/instructions')) return 'add_instruction';
  if (path.endsWith('/stop')) return 'stop';
  return OPERATION_BY_METHOD[method] ?? 'status_read';
}

/**
 * Whose agent is this, decided before anything reads its state.
 *
 * A mismatch and a missing agent both answer 404 (RULE-56). 403 would confirm the
 * agent exists, which lets someone enumerate other people's agents by id; the reply
 * has to be the same either way, so there is no `forbidden` branch to get wrong.
 *
 * The refusal is audited here rather than in the handlers, because the handlers never
 * run for a denied request — and a denial nobody recorded is the one worth recording.
 */
export function requireAgentOwner(options: {
  documents: DocumentStore;
  write?: (line: string) => void;
  now?: () => number;
}): MiddlewareHandler<AgentOwnerVariables> {
  return async (context, next) => {
    const agentId = context.req.param('agent_id') ?? '';
    const humanSubject = context.get('humanSubject');
    const deny = (): Response => {
      logAgentOperation({
        operation: operationFor(context.req.method, new URL(context.req.url).pathname),
        agent_id: agentId,
        actor_type: 'human',
        actor_id: humanSubject,
        on_behalf_of: humanSubject,
        occurred_at: new Date(options.now?.() ?? Date.now()).toISOString(),
        result: 'denied',
      }, options.write);
      return context.json({ error: 'not_found' }, 404);
    };

    let meta: { human_subject?: string } | undefined;
    try {
      meta = await options.documents.get<{ human_subject?: string }>('agents', `${agentId}__meta`);
    } catch {
      return deny();
    }
    if (!meta || meta.human_subject !== humanSubject) return deny();
    context.set('agentId', agentId);
    await next();
    return undefined;
  };
}
