import type { DocumentStore } from '@xaa/gcp';

export type ResourceKind = 'service_account' | 'crypto_key' | 'iam_binding' | 'cloud_run_service' | 'cloud_run_job';

export interface CreatedResource {
  kind: ResourceKind;
  /** The fully qualified GCP name. Never a short name or a template. */
  name: string;
  created_at: string;
  deleted_at?: string | null;
}

export interface DedicatedResourceRecord {
  agent_id: string;
  status: 'CREATING' | 'READY' | 'FAILED' | 'RELEASED';
  created: CreatedResource[];
  created_at: string;
  expires_at: string;
  last_error: string | null;
}

/**
 * DEC-IAC-23. The ledger of what was actually created for a FULL_ISOLATION agent.
 *
 * Cleanup reads only this: it never reconstructs a name from the agent id, because a
 * run that died halfway would then be asked to delete things that were never made,
 * and would miss anything whose naming rule had since changed.
 *
 * Each resource is appended the moment it exists, not in one batch at the end, so
 * the ledger is accurate even when creation fails partway.
 */
export function createDedicatedLedger(documents: DocumentStore, now: () => number = () => Date.now()) {
  const key = (agentId: string) => agentId;
  return {
    async open(agentId: string, expiresAt: string): Promise<void> {
      await documents.set('dedicated_resources', key(agentId), {
        agent_id: agentId, status: 'CREATING', created: [],
        created_at: new Date(now()).toISOString(), expires_at: expiresAt, last_error: null,
      } satisfies DedicatedResourceRecord);
    },

    async record(agentId: string, kind: ResourceKind, name: string): Promise<void> {
      const record = await documents.get<DedicatedResourceRecord>('dedicated_resources', key(agentId));
      if (!record) throw new Error(`no dedicated ledger for ${agentId}`);
      // Idempotent: a retried step must not double-list the same resource.
      if (record.created.some((entry) => entry.name === name)) return;
      await documents.update('dedicated_resources', key(agentId), {
        created: [...record.created, { kind, name, created_at: new Date(now()).toISOString(), deleted_at: null }],
      });
    },

    async markReady(agentId: string): Promise<void> {
      await documents.update('dedicated_resources', key(agentId), { status: 'READY' });
    },

    async markFailed(agentId: string, error: string): Promise<void> {
      await documents.update('dedicated_resources', key(agentId), { status: 'FAILED', last_error: error });
    },

    async read(agentId: string): Promise<DedicatedResourceRecord | undefined> {
      return documents.get<DedicatedResourceRecord>('dedicated_resources', key(agentId));
    },
  };
}
