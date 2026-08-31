import type { DocumentStore } from '@xaa/gcp';
import { writeStatus } from './status-writer.js';
import type { CleanupClients } from './clients/types.js';

/**
 * Quarantine stops the agent's identity, not the agent.
 *
 * Three things happen: the status changes, the OP stops issuing, and the Bridge
 * bindings are disabled. What deliberately does not happen is cancelling the Job
 * Execution or taking away its write access to its own checkpoint — the process keeps
 * running and keeps recording what it is doing.
 *
 * That is for evidence. An agent that has done something alarming is more useful alive
 * and unable to act than killed mid-step with its state half written. Stopping it comes
 * later, when someone decides to revoke it, and that path runs cleanup's step1.
 */
export async function quarantine(input: {
  documents: DocumentStore;
  clients: CleanupClients;
  agentId: string;
  bridgeBindingIds: readonly string[];
  severity?: 'CRITICAL';
  now?: number;
}): Promise<void> {
  await writeStatus({
    documents: input.documents, agentId: input.agentId, to: 'QUARANTINED',
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  await input.clients.agentOp.disableIssuance({
    baseUrl: input.clients.endpoints.agentOpUrl, agentId: input.agentId,
  });
  const bridgeUrl = input.clients.endpoints.bridgeUrl;
  if (bridgeUrl) {
    for (const bindingId of input.bridgeBindingIds) {
      await input.clients.bridge.disableBinding({ baseUrl: bridgeUrl, bindingId }).catch(() => undefined);
    }
  }
}
