import { assertAgentOwnership, type DocumentStore } from '@xaa/gcp';

export class FirestorePathDenied extends Error {
  readonly code = 'firestore_path_denied';
  constructor(readonly path: string, readonly operation: string) {
    super(`firestore_path_denied: ${operation} ${path}`);
  }
}

export interface RuntimeInstruction {
  instruction_id: string;
  body: string;
  created_at: string;
  applied_at: string | null;
}

/**
 * The four things a Runtime may touch, named individually.
 *
 * Firestore has no per-document IAM, so the boundary is drawn in the application
 * (DEV-05). Rather than expose a store and check paths inside it, this exposes four
 * operations and nothing else: there is no `collection()` accessor to route around,
 * and every one of them pins the agent id by exact string equality — a prefix match
 * would let `agent-aaa` reach `agent-aaa2`.
 *
 * Nothing here writes an Activity Event. Those go over Pub/Sub (T-RUN-25), so a
 * compromised Runtime cannot forge a row in someone's timeline.
 */
export interface RuntimeStore {
  readMeta(): Promise<Record<string, unknown> | undefined>;
  readManifest(): Promise<Record<string, unknown> | undefined>;
  readPendingInstructions(now: string): Promise<RuntimeInstruction[]>;
  writeState(state: Record<string, unknown>): Promise<void>;
}

export const RUNTIME_ALLOWED_OPERATIONS = [
  { operation: 'read', path: 'agents/{agent_id}/meta' },
  { operation: 'read', path: 'agents/{agent_id}/manifest' },
  { operation: 'read', path: 'agents/{agent_id}/instructions' },
  { operation: 'update', path: 'agents/{agent_id}/instructions' },
  { operation: 'write', path: 'agents/{agent_id}/state' },
] as const;

/**
 * Physical collection for the logical `agents/{agent_id}/instructions/{id}` of 00b §3.
 * Firestore paths alternate collection and document, and a query needs a collection
 * of its own, so instructions live flat with an `agent_id` field.
 */
const INSTRUCTIONS = 'agent_instructions';

export function createRuntimeStore(input: { documents: DocumentStore; agentId: string }): RuntimeStore {
  const own = (agentId: string): void => {
    if (agentId !== input.agentId) throw new FirestorePathDenied(`agents/${agentId}`, 'read');
    assertAgentOwnership(input.agentId, agentId);
  };
  return {
    async readMeta() {
      own(input.agentId);
      return input.documents.get('agents', `${input.agentId}__meta`);
    },
    async readManifest() {
      own(input.agentId);
      return input.documents.get('agents', `${input.agentId}__manifest`);
    },
    /**
     * Read and mark in one transaction (REQ-02-025). Splitting them would let two
     * reasoning steps, or two executions, apply the same instruction twice.
     */
    async readPendingInstructions(now: string) {
      own(input.agentId);
      return input.documents.transaction(async (tx) => {
        const pending = await tx.queryEqual<RuntimeInstruction>(INSTRUCTIONS, [
          ['agent_id', input.agentId], ['applied_at', null],
        ]);
        const ordered = [...pending].sort((left, right) => left.data.created_at.localeCompare(right.data.created_at));
        for (const row of ordered) tx.update(INSTRUCTIONS, row.id, { applied_at: now });
        return ordered.map((row) => ({ ...row.data, instruction_id: row.id }));
      });
    },
    async writeState(state) {
      own(input.agentId);
      await input.documents.set('agents', `${input.agentId}__state`, state);
    },
  };
}
