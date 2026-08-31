import type { CleanupContext } from '../../clients/types.js';

/**
 * step10. Removes the registration and the static XAA config from the OP, then the
 * local manifest.
 *
 * After this the agent has no identity anywhere: nothing to authenticate as, and
 * nothing describing what it was permitted to reach.
 */
export async function registrationDelete(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const status = await context.clients.agentOp.deleteRegistration({
    baseUrl: context.clients.endpoints.agentOpUrl,
    agentId: context.domain.agent_id,
  });
  if (status >= 500 || status === 0) throw new Error('registration_delete_failed');
  const manifest = await context.documents.get('agents', `${context.domain.agent_id}__manifest`);
  if (manifest) await context.documents.delete('agents', `${context.domain.agent_id}__manifest`).catch(() => undefined);
  return status === 404 && !manifest ? 'skipped' : 'succeeded';
}
