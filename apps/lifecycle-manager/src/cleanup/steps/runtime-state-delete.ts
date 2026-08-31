import type { CleanupContext } from '../../clients/types.js';

/**
 * step7. Removes what the agent was thinking.
 *
 * The checkpoint and the pending instructions go now; `meta` stays until step11,
 * because the audit summary is written from it. Deleting them in one sweep would mean
 * the record of what happened is gone before anyone writes it down.
 */
export async function runtimeStateDelete(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const agentId = context.domain.agent_id;
  const existing = await Promise.all([
    context.documents.get('agents', `${agentId}__state`),
    context.documents.get('agents', `${agentId}__instructions`),
  ]);
  if (existing.every((document) => document === undefined)) return 'skipped';
  await context.documents.delete('agents', `${agentId}__state`).catch(() => undefined);
  await context.documents.delete('agents', `${agentId}__instructions`).catch(() => undefined);
  return 'succeeded';
}
