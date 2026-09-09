import type { DocumentStore } from '@xaa/gcp';
import { isFaultKind } from '@xaa/contracts';
import type { StoredInstruction } from './instructions.js';

export interface FaultTrial {
  instruction_id: string;
  task_id: string;
  created_at: string;
  applied_at: string | null;
  state: 'queued' | 'received' | 'failed' | 'not_applied';
}

/** Called only after the agent ownership guard; never expose instruction text. */
export async function readFaultTrials(documents: DocumentStore, agentId: string, now = Date.now()): Promise<FaultTrial[]> {
  const [rows, checkpoint, meta] = await Promise.all([
    documents.queryEqual<StoredInstruction>('agent_instructions', [['agent_id', agentId]]),
    documents.get<{ task_context?: { task_id?: string }; execution_state?: { failure?: string; fault_instruction_id?: string } }>('agents', `${agentId}__state`),
    documents.get<{ status?: string; expires_at?: string }>('agents', `${agentId}__meta`),
  ]);
  return rows.filter(({ data }) => data.agent_id === agentId && isFaultKind(data.fault?.kind))
    .sort((a, b) => b.data.created_at.localeCompare(a.data.created_at)).slice(0, 10)
    .map(({ data }) => {
      const failed = checkpoint?.execution_state?.fault_instruction_id === data.instruction_id
        && checkpoint.execution_state.failure === 'injected_runtime_crash';
      const eligible = checkpoint?.task_context?.task_id === data.fault!.task_id
        && meta?.status === 'ACTIVE' && (!meta.expires_at || Date.parse(meta.expires_at) > now);
      return { instruction_id: data.instruction_id, task_id: data.fault!.task_id,
        created_at: data.created_at, applied_at: data.applied_at,
        state: failed ? 'failed' : data.applied_at ? 'received' : eligible ? 'queued' : 'not_applied' };
    });
}
