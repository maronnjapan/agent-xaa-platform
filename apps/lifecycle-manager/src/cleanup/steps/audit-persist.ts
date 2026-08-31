import { deleteDomain } from '../../domain.js';
import type { CleanupContext } from '../../clients/types.js';

export const AUDIT_FIELDS = [
  'agent_id', 'human_subject', 'isolation_level', 'dedicated_op', 'reason',
  'started_at', 'finished_at', 'step_results', 'job_execution_name',
  'idp_connection_id', 'bridge_binding_ids',
] as const;

const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * step11. Writes down what happened, then removes the last of the agent.
 *
 * The order matters: once `agents/{agent_id}` is gone there is nothing left to
 * describe, so the summary is emitted first. It goes to the structured log and reaches
 * BigQuery through the Log Sink — no BigQuery client here, because a service that could
 * write directly to the audit dataset could also write something untrue to it.
 */
export async function auditPersist(
  context: CleanupContext & { startedAt: string; stepResults: unknown[] },
): Promise<'succeeded'> {
  // The last step in every sense: it removes the document the earlier steps read, so it
  // must not run while any of them still has work to do. Failing here rather than
  // skipping keeps it on the retry list, and keeps the record alive for the retry.
  const outstanding = (context.stepResults as Array<{ step: string; status: string }>)
    .filter((entry) => entry.step !== 'audit_persist' && entry.status === 'failed');
  if (outstanding.length > 0) throw new Error('cleanup_incomplete');

  const line: Record<string, unknown> = {
    agent_id: context.domain.agent_id,
    human_subject: context.domain.human_subject,
    isolation_level: context.domain.isolation_level,
    dedicated_op: context.domain.dedicated_op,
    reason: context.reason,
    started_at: context.startedAt,
    finished_at: new Date(context.now()).toISOString(),
    step_results: context.stepResults,
    job_execution_name: context.domain.job_execution_name,
    idp_connection_id: context.domain.idp_connection_id,
    bridge_binding_ids: context.domain.bridge_binding_ids,
  };
  context.logger.info('agent_cleanup_completed', context.logContext, sanitize(line) as Record<string, unknown>);
  await deleteDomain(context.documents, context.domain.agent_id);
  return 'succeeded';
}

/** Last gate before the line leaves: no token shape, no credential-named key. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return JWT_SHAPE.test(value) ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/refresh_token|client_secret|private_key/i.test(key)) continue;
      output[key] = sanitize(item, depth + 1);
    }
    return output;
  }
  return value;
}
