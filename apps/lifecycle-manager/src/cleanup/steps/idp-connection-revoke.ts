import type { CleanupContext } from '../../clients/types.js';

/**
 * step3. Hands the agent's refresh token back to the Human IdP.
 *
 * The token is encrypted with a key this service deliberately cannot use: `sa-lifecycle`
 * has no permission on the connection-encryption key (DEC-IAC-08), so the decrypt and
 * the revoke both happen inside the Agent OP. What this step does is ask.
 *
 * Exactly one connection — the one belonging to this agent. Revoking by
 * `human_subject` would take out the person's other agents, and their browser session
 * with them, which is why there is no such call to make.
 */
export async function idpConnectionRevoke(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const connectionId = context.domain.idp_connection_id;
  if (!connectionId) return 'skipped';
  const status = await context.clients.agentOp.revokeIdpConnection({
    baseUrl: context.clients.endpoints.agentOpUrl,
    agentId: context.domain.agent_id,
    connectionId,
  });
  if (status === 404) return 'skipped';
  // A single error code, and no response body in the log: a revoke response can echo
  // the token it was given.
  if (status >= 500 || status === 0) throw new Error('idp_revoke_failed');
  return 'succeeded';
}
