import type { DocumentStore } from '@xaa/gcp';
import { transition, type AgentStatus } from './state-machine.js';
import type { CleanupReason } from './config.js';

export class AgentNotFound extends Error {
  readonly code = 'agent_not_found';
  constructor(readonly agentId: string) { super(`agent_not_found: ${agentId}`); }
}

/**
 * The only writer of an agent's status, anywhere in the platform.
 *
 * Reading the current value and applying the transition inside one Firestore
 * transaction is what makes the state machine mean anything: two concurrent sweeps
 * would otherwise both read ACTIVE and both write, and one of the writes would be a
 * transition that never actually happened.
 *
 * `status_changed_at` and `status_reason` are written with it, so the row always says
 * when and why — not just what.
 */
export async function writeStatus(input: {
  documents: DocumentStore;
  agentId: string;
  to: AgentStatus;
  reason?: CleanupReason;
  severity?: 'CRITICAL';
  now?: number;
}): Promise<{ from: AgentStatus; to: AgentStatus }> {
  const now = new Date(input.now ?? Date.now()).toISOString();
  return input.documents.transaction(async (tx) => {
    const meta = await tx.get<{ status?: AgentStatus }>('agents', `${input.agentId}__meta`);
    if (!meta) throw new AgentNotFound(input.agentId);
    const from = meta.status ?? 'CREATED';
    const to = transition(from, input.to, input.severity ? { severity: input.severity } : {});
    tx.update('agents', `${input.agentId}__meta`, {
      status: to,
      status_changed_at: now,
      status_reason: input.reason ?? null,
      ...(input.reason ? { cleanup_reason: input.reason } : {}),
    });
    return { from, to };
  });
}
