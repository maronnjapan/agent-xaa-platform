import {
  assertIsolationLevel, assertReasonCode,
  type CapabilityDecision, type Characteristics, type DelegatableEntry, type OrganizationPolicy, type RiskPolicy,
  type SecurityProfile,
} from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { AGENT_META_SUFFIX, AUTHZ_COLLECTIONS, humanPermissionId, permissionChangeReceiptId, policyDecisionId } from './collections.js';

export interface TaxonomyEntry {
  capability_id: string;
  resource: string;
  object?: string;
  action: string;
  description: string;
  /** Absent in the seeded data; the configured version stands in when it is (T-AUTHZ-24). */
  version?: string;
  default_characteristics?: Partial<Characteristics>;
}

/** The statuses a permission change still reaches (REQ-07-027). */
export const REEVALUATED_AGENT_STATUSES = ['ACTIVE', 'EXPIRING'] as const;

/** Only the four fields re-evaluation reads out of `agents/{agent_id}/meta`. */
export interface AgentSummary {
  agent_id: string;
  human_subject: string;
  status: string;
  created_at: string;
}

/**
 * The stored proposal, read back. `effective_capabilities` is deliberately absent:
 * what the AI proposed and what the Policy Engine allowed are separate records
 * (RULE-10), and a re-evaluation that read the old effective set as its input would
 * ratchet the decision instead of recomputing it.
 */
export interface StoredProposal {
  decision_id: string;
  work_definition_id: string;
  proposed_capabilities: string[];
  characteristics: Characteristics;
  taxonomy_version: string;
  model_version: string;
}

export interface StoredDecision {
  decision_id: string;
  status: string;
  human_subject: string;
  work_definition_id: string;
  effective_capabilities: string[];
  security_profile: SecurityProfile;
  created_at: string;
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
  getProposalByDecisionId(decisionId: string): Promise<StoredProposal | undefined>;
  getDecision(decisionId: string): Promise<StoredDecision | undefined>;
  listActiveDecisionsBySubject(humanSubject: string): Promise<StoredDecision[]>;
  listAgentsBySubject(humanSubject: string): Promise<AgentSummary[]>;
  claimPermissionChange(humanSubject: string, changedAt: string, receivedAt: string): Promise<boolean>;
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

    /**
     * The isolation level is checked here as well as at the API edge: a third value
     * reaching the stored profile would be read back by the Provisioner as the agent's
     * containment, and no later step re-derives it. This validation is what stands in
     * for the CHECK constraint of a relational schema (DEV-05).
     */
    async saveDecision(decisionId, decision) {
      const profile = decision.security_profile as { isolation_level?: unknown } | undefined;
      assertIsolationLevel(profile?.isolation_level);
      await documents.set(AUTHZ_COLLECTIONS.authorizationDecisions, decisionId, decision);
    },

    /**
     * Both ALLOW and DENY go to the same collection, one row per evaluated
     * capability, so an audit can see what was considered and not only what survived.
     * The reason code is checked before any write: this validation stands in for the
     * CHECK constraint a relational schema would have (DEV-05).
     *
     * All the rows commit together. A partial write would leave "one row per proposed
     * capability" false for a decision that has already been answered, and nothing
     * later goes back to repair it.
     */
    async savePolicyDecisions(decisionId, decisions, createdAt) {
      for (const decision of decisions) assertReasonCode(decision.reason_code);
      await documents.transaction(async (tx) => {
        for (const decision of decisions) {
          tx.set(AUTHZ_COLLECTIONS.policyDecisions, policyDecisionId(decisionId, decision.capability_id), {
            decision_id: decisionId,
            capability_id: decision.capability_id,
            decision: decision.decision,
            reason_code: decision.reason_code,
            policy_id: decision.policy_id,
            created_at: createdAt,
          });
        }
      });
      return decisions.length;
    },

    async getProposalByDecisionId(decisionId) {
      const rows = await documents.queryEqual<StoredProposal>(
        AUTHZ_COLLECTIONS.aiProposals, [['decision_id', decisionId]], 1,
      );
      return rows[0]?.data;
    },

    async getDecision(decisionId) {
      return documents.get<StoredDecision>(AUTHZ_COLLECTIONS.authorizationDecisions, decisionId);
    },

    /**
     * The decisions that actually granted something, newest first. A
     * `no_capability_inferred` record is a decision too, but it never produced an
     * agent, so it is not a candidate for re-evaluation.
     */
    async listActiveDecisionsBySubject(humanSubject) {
      const rows = await documents.queryEqual<StoredDecision>(
        AUTHZ_COLLECTIONS.authorizationDecisions, [['human_subject', humanSubject], ['status', 'decided']],
      );
      return rows.map(({ data }) => data).sort((left, right) => right.created_at.localeCompare(left.created_at));
    },

    /**
     * The agents of one person, and no one else's: the subject is part of the query
     * rather than a filter applied afterwards, so a mistake here cannot widen into
     * another person's agents.
     *
     * `agents` also holds each agent's state, manifest and instructions as sibling
     * documents; only the registration carries `human_subject`, and the id suffix is
     * checked as well so a future document with that field cannot be mistaken for one.
     */
    async listAgentsBySubject(humanSubject) {
      const rows = await documents.queryEqual<AgentSummary>(
        AUTHZ_COLLECTIONS.agents, [['human_subject', humanSubject]],
      );
      return rows
        .filter(({ id }) => id.endsWith(AGENT_META_SUFFIX))
        .map(({ data }) => data)
        .filter((agent) => (REEVALUATED_AGENT_STATUSES as readonly string[]).includes(agent.status))
        .sort((left, right) => left.agent_id.localeCompare(right.agent_id));
    },

    /**
     * Registers one permission change and reports whether this delivery is the first.
     * `create` is the claim itself — reading and then writing would let two
     * simultaneous deliveries both find the receipt missing and both re-evaluate.
     */
    async claimPermissionChange(humanSubject, changedAt, receivedAt) {
      try {
        await documents.create(
          AUTHZ_COLLECTIONS.permissionChangeReceipts,
          permissionChangeReceiptId(humanSubject, changedAt),
          { human_subject: humanSubject, changed_at: changedAt, received_at: receivedAt },
        );
        return true;
      } catch (error) {
        if ((error as { code?: number }).code === 6) return false;
        throw error;
      }
    },
  };
}

export { humanPermissionId };
