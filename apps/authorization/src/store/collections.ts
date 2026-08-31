/**
 * Every collection name and document id this app uses. No other file writes a
 * collection name as a literal, so the reachable data surface is one screen long.
 */
export const AUTHZ_COLLECTIONS = {
  workDefinitions: 'work_definitions',
  capabilityTaxonomy: 'capability_taxonomy',
  humanPermissions: 'human_permissions',
  delegatablePermissions: 'delegatable_permissions',
  organizationPolicies: 'organization_policies',
  riskPolicies: 'risk_policies',
  aiProposals: 'ai_proposals',
  authorizationDecisions: 'authorization_decisions',
  policyDecisions: 'policy_decisions',
  catalogTools: 'catalog_tools',
} as const;

/** `human_permissions` is one row per (subject, capability) pair (00b §3). */
export function humanPermissionId(humanSubject: string, capabilityId: string): string {
  return `${humanSubject}__${capabilityId}`;
}

export function policyDecisionId(decisionId: string, capabilityId: string): string {
  return `${decisionId}__${capabilityId}`;
}
