import { AGENT_URN_PREFIX, isAgentId } from '@xaa/contracts';

export class NamespaceViolation extends Error {
  readonly code = 'invalid_request';
  constructor() { super('The identities in the request are not distinct'); }
}

/**
 * REQ-01-004. `agent-` is a namespace of its own: a human `sub` may never take that
 * shape, and an actor may never equal the subject. Comparison is exact equality —
 * no prefix or substring matching.
 *
 * A namespace violation is invalid_request; a delegation mismatch is invalid_grant.
 * They are different failures and keep different codes (T-OP-18).
 */
export function assertDistinctIdentities(humanSub: string, actorSub: string): void {
  const agentId = actorSub.startsWith(AGENT_URN_PREFIX) ? actorSub.slice(AGENT_URN_PREFIX.length) : actorSub;
  if (agentId === humanSub) throw new NamespaceViolation();
  if (isAgentId(humanSub) || String(humanSub).startsWith('agent-')) throw new NamespaceViolation();
}
