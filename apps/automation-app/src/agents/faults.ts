import type { DocumentStore } from '@xaa/gcp';
import { isFaultKind, type FaultKind } from '@xaa/contracts';
import type { StoredInstruction } from './instructions.js';

export interface FaultTrial {
  instruction_id: string;
  task_id: string;
  kind: FaultKind;
  created_at: string;
  applied_at: string | null;
  state: 'queued' | 'received' | 'failed' | 'not_applied';
}

/**
 * The person's own failure exercises, newest first, each with how far it got.
 *
 * `failed` — the name the screen has always used for "the Runtime did what was asked"
 * — is decided by one thing: the checkpoint names this request as the one it applied.
 * A crash leaves an execution failure beside that id and a failed tool call does not,
 * so matching on the failure would confirm one kind and never the other. The kind
 * travels with the trial so the screen can say what a confirmed one of it looks like.
 *
 * Called only after the agent ownership guard, and the instruction's text is never
 * exposed: a trial is the request, the task and the state, and nothing a person wrote.
 */
export async function readFaultTrials(documents: DocumentStore, agentId: string, now = Date.now()): Promise<FaultTrial[]> {
  const [rows, checkpoint, meta] = await Promise.all([
    documents.queryEqual<StoredInstruction>('agent_instructions', [['agent_id', agentId]]),
    documents.get<{ task_context?: { task_id?: string }; execution_state?: { fault_instruction_id?: string } }>('agents', `${agentId}__state`),
    documents.get<{ status?: string; expires_at?: string }>('agents', `${agentId}__meta`),
  ]);
  return rows.filter(({ data }) => data.agent_id === agentId && isFaultKind(data.fault?.kind))
    .sort((a, b) => b.data.created_at.localeCompare(a.data.created_at)).slice(0, 10)
    .map(({ data }) => {
      const fault = data.fault!;
      const confirmed = checkpoint?.execution_state?.fault_instruction_id === data.instruction_id;
      const eligible = checkpoint?.task_context?.task_id === fault.task_id
        && meta?.status === 'ACTIVE' && (!meta.expires_at || Date.parse(meta.expires_at) > now);
      return { instruction_id: data.instruction_id, task_id: fault.task_id, kind: fault.kind,
        created_at: data.created_at, applied_at: data.applied_at,
        state: confirmed ? 'failed' : data.applied_at ? 'received' : eligible ? 'queued' : 'not_applied' };
    });
}
