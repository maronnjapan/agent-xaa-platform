import type { CapabilityDecision, DelegatableEntry } from '@xaa/contracts';

export const IMPLICIT_NOT_DELEGATABLE = 'implicit-not-delegatable';

/**
 * RULE-11, the delegation step. A capability the human holds is not automatically
 * one an agent may hold on their behalf.
 *
 * Absence from the table means not delegatable. There is no branch that defaults to
 * allowing, so forgetting to register a capability fails closed.
 */
export function applyDelegatable(
  capabilities: string[],
  entries: Map<string, DelegatableEntry>,
): { kept: string[]; denied: CapabilityDecision[] } {
  const kept: string[] = [];
  const denied: CapabilityDecision[] = [];
  for (const capability of capabilities) {
    const entry = entries.get(capability);
    if (entry?.delegatable === true) { kept.push(capability); continue; }
    denied.push({
      capability_id: capability,
      decision: 'DENY',
      reason_code: 'not_delegatable',
      policy_id: entry?.policy_id ?? IMPLICIT_NOT_DELEGATABLE,
    });
  }
  return { kept, denied };
}
