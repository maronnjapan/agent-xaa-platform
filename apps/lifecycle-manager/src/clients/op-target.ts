import type { AgentIdentityDomain } from '../domain.js';
import type { CleanupClients } from './types.js';

/**
 * Which OP answers for this agent.
 *
 * A STANDARD agent is registered at the shared Agent OP, whose URL comes from
 * endpoints.json. A FULL_ISOLATION agent is not: the Provisioner built it a Cloud Run
 * service of its own at provisioning time and recorded the address on the agent's
 * record (`dedicated_op`), which is the only place that address exists — it is
 * allocated at runtime, so no configuration file and no naming rule can produce it.
 *
 * Sending a full-isolation agent's revocation to the shared OP would be answered with a
 * 404 for an agent it has never heard of, and cleanup would read that as "already
 * gone" — the worst possible outcome, since the registration it should have disabled is
 * alive on a service nobody asked.
 */
export function agentOpUrlFor(domain: AgentIdentityDomain, clients: CleanupClients): string {
  if (domain.isolation_level === 'full_isolation' && domain.dedicated_op) return domain.dedicated_op;
  return clients.endpoints.agentOpUrl;
}
