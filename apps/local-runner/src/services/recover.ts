import { createFirestoreDocumentStore } from '@xaa/gcp';
import type { CleanupReason } from '@xaa/lifecycle-manager/src/config';
import type { LocalPlatform } from '../platform.js';

interface AgentMeta {
  agent_id?: string;
  status?: string;
}

/**
 * Ends the agents the last run left behind.
 *
 * State that outlives the process does not make an agent outlive it. An agent's own
 * client credential exists only in the environment of the Execution running it
 * (RULE-22), a `full_isolation` agent's OP is a listener in the process that provisioned
 * it, and both are gone. What the restored rows hold is therefore a description of an
 * agent, not an agent — and a platform that showed it as ACTIVE would be inviting a
 * person to watch something that cannot act and cannot be stopped, on a ToDo they can
 * neither close nor withdraw while it is running.
 *
 * So the run begins by ending them, through the Lifecycle Manager's own cleanup rather
 * than by writing a status: the tokens already issued are revoked, the OP stops issuing
 * more, the record is audited and removed. The reason is EXPIRED because that is what
 * happened — the agent's life ended with the process — and because it is not one of the
 * abnormal reasons, which would hand the person's upstream refresh token back to the
 * SaaS and break the connection for every other agent (docs 07 §6).
 *
 * Returns the agents it ended, for the line the runner prints.
 */
export async function endAgentsFromPreviousRun(
  platform: LocalPlatform,
  cleanup: (agentId: string, reason: CleanupReason) => Promise<unknown>,
): Promise<string[]> {
  const documents = createFirestoreDocumentStore(platform.firestore, 'lifecycle-manager');
  const rows = await documents.queryRange<AgentMeta>('agents', 'agent_id', 'agent-', 'agent-￿');
  const stranded = rows
    // An agent is its `meta` sub-document. `manifest` carries `agent_id` too and so
    // comes back from the same query, and cleaning up an agent twice per start would be
    // a second pass over a record the first one already deleted.
    .filter((row) => row.id.endsWith('__meta'))
    .map((row) => row.data)
    .filter((meta): meta is AgentMeta & { agent_id: string } => typeof meta.agent_id === 'string')
    .filter((meta) => meta.status !== 'DESTROYED');

  for (const meta of stranded) {
    // One failing agent must not stop the platform from starting. A cleanup that could
    // not finish leaves the agent REVOKED with its failed steps recorded, and the
    // Lifecycle Manager's sweep picks it up on the next tick.
    await cleanup(meta.agent_id, 'EXPIRED').catch((error: unknown) => {
      process.stderr.write(`[local] could not end ${meta.agent_id} from the previous run: ${(error as Error).message}\n`);
    });
  }
  return stranded.map((meta) => meta.agent_id);
}
