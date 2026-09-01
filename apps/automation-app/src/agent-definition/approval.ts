import { randomUUID } from 'node:crypto';
import { sha256Base64Url } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';

export interface AgentDefinition {
  agent_definition_id: string;
  human_subject: string;
  work_definition_id: string;
  decision_id: string;
  presented_capabilities: string[];
  presented_capabilities_hash: string;
  isolation_level: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

export class ApprovalRequired extends Error { readonly code = 'approval_required'; }
export class CapabilitiesChanged extends Error { readonly code = 'capabilities_changed'; }
export class AlreadyApproved extends Error { readonly code = 'already_approved'; }

/**
 * A fingerprint of what the person was actually shown.
 *
 * Sorting first makes the hash independent of the order the Authorization Platform
 * happened to return — two identical permission sets must agree, or every re-fetch
 * would look like a change. What it must catch is a set that gained or lost a member
 * between the screen and the click (RULE-08).
 */
export async function capabilitiesHash(capabilities: readonly string[]): Promise<string> {
  return sha256Base64Url([...capabilities].sort().join('\n'));
}

export interface AgentDefinitionStore {
  create(input: {
    humanSubject: string;
    workDefinitionId: string;
    decisionId: string;
    capabilities: string[];
    isolationLevel: string;
  }, now?: number): Promise<AgentDefinition>;
  find(id: string): Promise<AgentDefinition | undefined>;
  approve(id: string, humanSubject: string, now?: number): Promise<AgentDefinition>;
}

export function createAgentDefinitionStore(documents: DocumentStore): AgentDefinitionStore {
  return {
    async create(input, now = Date.now()) {
      const definition: AgentDefinition = {
        agent_definition_id: `ad_${randomUUID()}`,
        human_subject: input.humanSubject,
        work_definition_id: input.workDefinitionId,
        decision_id: input.decisionId,
        presented_capabilities: input.capabilities,
        presented_capabilities_hash: await capabilitiesHash(input.capabilities),
        isolation_level: input.isolationLevel,
        approved_by: null,
        approved_at: null,
        created_at: new Date(now).toISOString(),
      };
      await documents.set('agent_definitions', definition.agent_definition_id, definition as unknown as Record<string, unknown>);
      return definition;
    },
    async find(id) {
      return documents.get<AgentDefinition>('agent_definitions', id);
    },
    /**
     * Approving twice is refused: the second click would restate consent nobody gave.
     *
     * Someone else's definition is refused the same way a missing one is. Approval is
     * the record of a particular person having looked at a particular permission set
     * (RULE-08), so it can only be given by the person the set was shown to — and
     * answering differently for "not yours" than for "not there" would let ids be
     * probed for existence (RULE-56).
     */
    async approve(id, humanSubject, now = Date.now()) {
      const existing = await documents.get<AgentDefinition>('agent_definitions', id);
      if (!existing || existing.human_subject !== humanSubject) throw new ApprovalRequired();
      if (existing.approved_at !== null) throw new AlreadyApproved();
      const approved: AgentDefinition = {
        ...existing, approved_by: humanSubject, approved_at: new Date(now).toISOString(),
      };
      await documents.set('agent_definitions', id, approved as unknown as Record<string, unknown>);
      return approved;
    },
  };
}

/**
 * Checked immediately before the Provisioning request leaves.
 *
 * A permission set can change between approval and submission — a policy edit, a
 * revoked human permission. Sending anyway would provision an agent the person never
 * saw. There is deliberately no automatic re-approval: the person has to look again.
 */
export async function assertStillApproved(definition: AgentDefinition, current: readonly string[]): Promise<void> {
  if (definition.approved_at === null) throw new ApprovalRequired();
  if (await capabilitiesHash(current) !== definition.presented_capabilities_hash) throw new CapabilitiesChanged();
}
