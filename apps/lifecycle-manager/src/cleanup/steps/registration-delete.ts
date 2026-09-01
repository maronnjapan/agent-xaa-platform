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

  // The Agent Binding rows go with it. Disabling them (step4) stops their use; leaving
  // them behind would keep a record saying this agent may reach a SaaS it no longer is.
  const bridgeUrl = context.clients.endpoints.bridgeUrl;
  if (bridgeUrl && context.domain.bridge_binding_ids.length > 0) {
    const deleted = await context.clients.bridge.deleteBindings({
      baseUrl: bridgeUrl, agentId: context.domain.agent_id,
    });
    if (deleted >= 500 || deleted === 0) throw new Error('bridge_binding_delete_failed');
  }

  const manifest = await context.documents.get('agents', `${context.domain.agent_id}__manifest`);
  if (manifest) await context.documents.delete('agents', `${context.domain.agent_id}__manifest`).catch(() => undefined);
  return status === 404 && !manifest ? 'skipped' : 'succeeded';
}
