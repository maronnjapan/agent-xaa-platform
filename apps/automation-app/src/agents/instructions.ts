import { randomUUID } from 'node:crypto';
import type { DocumentStore } from '@xaa/gcp';

export class AgentNotActive extends Error { readonly code = 'agent_not_active'; }

export interface StoredInstruction {
  instruction_id: string;
  agent_id: string;
  text: string;
  created_at: string;
  created_by: string;
  applied_at: string | null;
}

/**
 * Adds one instruction to a running agent — and nothing else.
 *
 * The record has no field for a capability, a tool or a scope, so an instruction can
 * only ever be words. That is RULE-13 made structural: a running agent's permissions
 * were fixed when it was provisioned, and the way to keep them fixed is for the
 * channel into it to carry nothing that could widen them. If the words ask for
 * something outside the manifest, the Runtime's step2 refuses it (T-RUN-23).
 *
 * The status check and the write share one transaction: an agent that expires between
 * the two would otherwise receive an instruction nobody will ever read.
 */
export async function addInstruction(input: {
  documents: DocumentStore;
  agentId: string;
  text: string;
  createdBy: string;
  now?: number;
}): Promise<StoredInstruction> {
  const now = new Date(input.now ?? Date.now()).toISOString();
  const instruction: StoredInstruction = {
    instruction_id: `ins_${randomUUID()}`,
    agent_id: input.agentId,
    text: input.text,
    created_at: now,
    // The person's subject, never their token: an audit trail should say who asked,
    // not carry a credential that could be replayed.
    created_by: input.createdBy,
    applied_at: null,
  };
  return input.documents.transaction(async (transaction) => {
    const state = await transaction.get<{ agent_status?: string }>('agents', `${input.agentId}__state`);
    const meta = await transaction.get<{ status?: string }>('agents', `${input.agentId}__meta`);
    const status = state?.agent_status ?? meta?.status;
    if (status !== 'ACTIVE') throw new AgentNotActive();
    transaction.set('agent_instructions', instruction.instruction_id, instruction as unknown as Record<string, unknown>);
    return instruction;
  });
}
