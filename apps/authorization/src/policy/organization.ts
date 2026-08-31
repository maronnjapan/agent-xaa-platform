import type { CapabilityDecision, OrganizationPolicy } from '@xaa/contracts';

export class ConflictingConstraint extends Error {
  constructor(readonly capabilityId: string, readonly key: string) {
    super(`two organization policies set a different ${key} on ${capabilityId}`);
  }
}

function matches(policy: OrganizationPolicy, capability: string, connectors: string[]): boolean {
  if (policy.match.capability_id !== undefined) return policy.match.capability_id === capability;
  if (policy.match.connector_not_in !== undefined) {
    // Removed only when none of the capability's connectors is allowed. One allowed
    // connector is enough to keep it: the capability is still reachable safely.
    return !connectors.some((connector) => policy.match.connector_not_in!.includes(connector));
  }
  return false;
}

/**
 * T-AUTHZ-17. Two shapes of organisation rule, and the difference matters: a deny
 * removes the capability, a constraint keeps it and narrows how it may be used.
 *
 * "No mail outside the company" is a constraint, not a deny — the agent may still
 * send mail, to a restricted set of domains. Modelling it as a deny would take away
 * a capability the human legitimately delegated.
 */
export function applyOrganizationPolicy(
  capabilities: string[],
  policies: OrganizationPolicy[],
  capabilityConnectors: Record<string, string[]>,
): { kept: string[]; constraints: Record<string, Record<string, unknown>>; denied: CapabilityDecision[] } {
  const kept: string[] = [];
  const denied: CapabilityDecision[] = [];
  const constraints: Record<string, Record<string, unknown>> = {};

  for (const capability of capabilities) {
    const connectors = capabilityConnectors[capability] ?? [];
    const denying = policies.find((policy) => policy.type === 'capability_deny' && matches(policy, capability, connectors));
    if (denying) {
      denied.push({ capability_id: capability, decision: 'DENY', reason_code: 'org_policy_denied', policy_id: denying.policy_id });
      continue;
    }
    kept.push(capability);
    for (const policy of policies) {
      if (policy.type !== 'capability_constraint' || !matches(policy, capability, connectors)) continue;
      const target = constraints[capability] ?? {};
      for (const [key, value] of Object.entries(policy.constraint)) {
        // Two policies narrowing the same key in different ways is a policy-authoring
        // mistake, not something to resolve by ordering.
        if (key in target && JSON.stringify(target[key]) !== JSON.stringify(value)) {
          throw new ConflictingConstraint(capability, key);
        }
        target[key] = value;
      }
      constraints[capability] = target;
    }
  }
  return { kept, constraints, denied };
}
