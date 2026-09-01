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
  // Read-only for this app: re-evaluation has to know which agents a permission
  // change actually reaches, and that is the only fact it takes from here.
  agents: 'agents',
  permissionChangeReceipts: 'permission_change_receipts',
} as const;

/** `human_permissions` is one row per (subject, capability) pair (00b §3). */
export function humanPermissionId(humanSubject: string, capabilityId: string): string {
  return `${humanSubject}__${capabilityId}`;
}

export function policyDecisionId(decisionId: string, capabilityId: string): string {
  return `${decisionId}__${capabilityId}`;
}

/**
 * The idempotency key of one permission change (T-AUTHZ-27). Pub/Sub delivers at
 * least once, so the pair that identifies the change — not the message id, which
 * differs per delivery — is what the receipt is keyed by.
 */
export function permissionChangeReceiptId(humanSubject: string, changedAt: string): string {
  return `${humanSubject}:${changedAt}`;
}

/** `agents/{agent_id}/meta` stored flat, the way `DocumentStore` maps sub-documents. */
export const AGENT_META_SUFFIX = '__meta';
