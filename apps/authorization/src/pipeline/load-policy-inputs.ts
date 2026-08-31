import type { Characteristics, PolicyEngineInput } from '@xaa/contracts';
import type { AuthorizationStore } from '../store/authorization-store.js';

/**
 * REQ-03-021. Every input the Policy Engine needs is fetched here, in one place,
 * before it runs. The engine itself performs no I/O, so a decision can be replayed
 * from its recorded inputs alone.
 */
export async function loadPolicyInputs(
  humanSubject: string,
  proposed: string[],
  characteristics: Characteristics,
  store: AuthorizationStore,
): Promise<PolicyEngineInput> {
  const [humanPermissions, delegatableEntries, organizationPolicies, riskPolicies, capabilityConnectors] = await Promise.all([
    store.loadHumanPermissions(humanSubject),
    store.loadDelegatable(),
    store.loadOrganizationPolicies(),
    store.loadRiskPolicies(),
    store.loadCapabilityConnectors(),
  ]);
  return { proposed, characteristics, humanPermissions, delegatableEntries, organizationPolicies, capabilityConnectors, riskPolicies };
}
