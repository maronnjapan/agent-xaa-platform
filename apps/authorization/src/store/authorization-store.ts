import { assertReasonCode, type CapabilityDecision, type Characteristics, type DelegatableEntry, type OrganizationPolicy, type RiskPolicy } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { AUTHZ_COLLECTIONS, humanPermissionId, policyDecisionId } from './collections.js';

export interface TaxonomyEntry {
  capability_id: string;
  resource: string;
  object?: string;
  action: string;
  description: string;
  default_characteristics?: Partial<Characteristics>;
}

export interface AuthorizationStore {
  loadTaxonomy(): Promise<TaxonomyEntry[]>;
  loadHumanPermissions(humanSubject: string): Promise<string[]>;
  loadDelegatable(): Promise<Map<string, DelegatableEntry>>;
  loadOrganizationPolicies(): Promise<OrganizationPolicy[]>;
  loadRiskPolicies(): Promise<RiskPolicy[]>;
  loadCapabilityConnectors(): Promise<Record<string, string[]>>;
  saveWorkDefinition(workDefinition: Record<string, unknown>): Promise<void>;
  saveProposal(proposalId: string, proposal: Record<string, unknown>): Promise<void>;
  saveDecision(decisionId: string, decision: Record<string, unknown>): Promise<void>;
  savePolicyDecisions(decisionId: string, decisions: CapabilityDecision[], createdAt: string): Promise<number>;
}

export function createAuthorizationStore(documents: DocumentStore): AuthorizationStore {
  return {
    async loadTaxonomy() {
      return (await documents.listAll<TaxonomyEntry>(AUTHZ_COLLECTIONS.capabilityTaxonomy)).map(({ data }) => data);
    },

    async loadHumanPermissions(humanSubject) {
      const rows = await documents.queryEqual<{ capability_id: string }>(
        AUTHZ_COLLECTIONS.humanPermissions, [['human_subject', humanSubject]],
      );
      return rows.map(({ data }) => data.capability_id).sort();
    },

    async loadDelegatable() {
      const rows = await documents.listAll<DelegatableEntry>(AUTHZ_COLLECTIONS.delegatablePermissions);
      return new Map(rows.map(({ data }) => [data.capability_id, data]));
    },

    async loadOrganizationPolicies() {
      return (await documents.listAll<OrganizationPolicy>(AUTHZ_COLLECTIONS.organizationPolicies)).map(({ data }) => data);
    },

    async loadRiskPolicies() {
      return (await documents.listAll<RiskPolicy>(AUTHZ_COLLECTIONS.riskPolicies)).map(({ data }) => data);
    },

    /**
     * REQ-03-021: the Policy Engine must not reach the Tool Catalog itself, so the
     * capability-to-connector map is resolved here, before it runs.
     */
    async loadCapabilityConnectors() {
      const tools = await documents.listAll<{ required_capability: string; connector_id: string }>(AUTHZ_COLLECTIONS.catalogTools);
      const map: Record<string, string[]> = {};
      for (const { data } of tools) {
        const list = map[data.required_capability] ?? [];
        if (!list.includes(data.connector_id)) list.push(data.connector_id);
        map[data.required_capability] = list;
      }
      return map;
    },

    async saveWorkDefinition(workDefinition) {
      await documents.set(AUTHZ_COLLECTIONS.workDefinitions, String(workDefinition.work_definition_id), workDefinition);
    },

    async saveProposal(proposalId, proposal) {
      await documents.set(AUTHZ_COLLECTIONS.aiProposals, proposalId, proposal);
    },

    async saveDecision(decisionId, decision) {
      await documents.set(AUTHZ_COLLECTIONS.authorizationDecisions, decisionId, decision);
    },

    /**
     * Both ALLOW and DENY go to the same collection, one row per evaluated
     * capability, so an audit can see what was considered and not only what survived.
     * The reason code is checked before any write: this validation stands in for the
     * CHECK constraint a relational schema would have (DEV-05).
     */
    async savePolicyDecisions(decisionId, decisions, createdAt) {
      for (const decision of decisions) assertReasonCode(decision.reason_code);
      for (const decision of decisions) {
        await documents.set(AUTHZ_COLLECTIONS.policyDecisions, policyDecisionId(decisionId, decision.capability_id), {
          decision_id: decisionId,
          capability_id: decision.capability_id,
          decision: decision.decision,
          reason_code: decision.reason_code,
          policy_id: decision.policy_id,
          created_at: createdAt,
        });
      }
      return decisions.length;
    },
  };
}

export { humanPermissionId };
