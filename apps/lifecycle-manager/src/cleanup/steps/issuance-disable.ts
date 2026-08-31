import type { CleanupContext } from '../../clients/types.js';

/**
 * step2. Tells the agent's OP to stop issuing for it.
 *
 * Cancelling the execution stops the agent from asking; this stops the OP from
 * answering. Both are needed, because a token minted a moment before the cancel is
 * still valid for its lifetime, and a paused execution can be resumed by nothing but
 * this platform — while a live registration can be used by anyone holding the key.
 *
 * 404 counts as success: a registration that is already gone cannot issue anything.
 */
export async function issuanceDisable(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const status = await context.clients.agentOp.disableIssuance({
    baseUrl: context.clients.endpoints.agentOpUrl,
    agentId: context.domain.agent_id,
  });
  if (status === 404) return 'skipped';
  if (status >= 500 || status === 0) throw new Error('agent_op_unavailable');
  return 'succeeded';
}
