export const AGENT_SECURITY_STATES = ['ACTIVE', 'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED'] as const;
export type AgentSecurityState = (typeof AGENT_SECURITY_STATES)[number];

/**
 * Response only ever escalates.
 *
 * An agent that was quarantined is not un-quarantined by a later, quieter finding: the
 * evidence that led there does not stop existing. Recovery is a person's decision made
 * through the Lifecycle Manager, not something a detection run can do on its own — so
 * this returns `false` for every backward move and for staying put.
 */
export function canTransition(from: AgentSecurityState, to: AgentSecurityState): boolean {
  const source = AGENT_SECURITY_STATES.indexOf(from);
  const target = AGENT_SECURITY_STATES.indexOf(to);
  // A state this ladder does not know is not a rung below ACTIVE; it is not on the
  // ladder. Treating an unknown `from` as -1 would have made every move out of it legal.
  if (source < 0 || target < 0) return false;
  return target > source;
}
