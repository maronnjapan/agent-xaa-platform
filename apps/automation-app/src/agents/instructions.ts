import { randomUUID } from 'node:crypto';
import type { FaultKind, InstructionFault } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

export class AgentNotActive extends Error { readonly code = 'agent_not_active'; }

export interface StoredInstruction {
  instruction_id: string;
  agent_id: string;
  text: string;
  created_at: string;
  created_by: string;
  applied_at: string | null;
  fault?: InstructionFault;
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
  fault?: FaultKind;
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
    const state = await transaction.get<{ agent_status?: string; task_context?: { task_id?: string } }>('agents', `${input.agentId}__state`);
    const meta = await transaction.get<{ status?: string; expires_at?: string }>('agents', `${input.agentId}__meta`);
    const status = meta?.status && meta.status !== 'ACTIVE' ? meta.status : state?.agent_status ?? meta?.status;
    if (status !== 'ACTIVE' || (meta?.expires_at && Date.parse(meta.expires_at) <= Date.parse(now))) throw new AgentNotActive();
    if (input.fault) {
      const taskId = state?.task_context?.task_id;
      if (!taskId) throw new AgentNotActive();
      const pending = await transaction.queryEqual<StoredInstruction>('agent_instructions', [
        ['agent_id', input.agentId], ['applied_at', null],
      ]);
      if (pending.some((row) => row.data.fault?.task_id === taskId)) throw new FaultAlreadyPending();
      instruction.fault = { kind: input.fault, task_id: taskId };
    }
    transaction.set('agent_instructions', instruction.instruction_id, instruction as unknown as Record<string, unknown>);
    return instruction;
  });
}

export class FaultAlreadyPending extends Error { readonly code = 'fault_already_pending'; }
