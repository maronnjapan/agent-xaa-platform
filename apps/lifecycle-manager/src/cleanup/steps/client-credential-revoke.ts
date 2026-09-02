import type { CleanupContext } from '../../clients/types.js';
import { agentOpUrlFor } from '../../clients/op-target.js';

/**
 * step6. Revokes the Agent Client Credential.
 *
 * Once the registration's thumbprint is gone, the agent's `client_assertion_jwt`
 * (DEC-ID-11) no longer verifies, so it cannot authenticate to its OP even if the
 * private key somehow survives the process it lived in.
 *
 * The shared ID-JAG signing key is not touched. Every standard agent signs with it,
 * and disabling it here would revoke the whole platform to clean up one agent. A
 * dedicated key is a different matter, and step8 handles that.
 */
export async function clientCredentialRevoke(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const status = await context.clients.agentOp.revokeClientCredential({
    baseUrl: agentOpUrlFor(context.domain, context.clients),
    agentId: context.domain.agent_id,
  });
  if (status === 404) return 'skipped';
  if (status >= 500 || status === 0) throw new Error('client_credential_revoke_failed');
  return 'succeeded';
}
