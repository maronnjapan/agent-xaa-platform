import { assertRuntimeName } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

export type ResourceKind = 'service_account' | 'crypto_key' | 'iam_binding' | 'cloud_run_service' | 'cloud_run_job';

export interface CreatedResource {
  kind: ResourceKind;
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
 * What to delete, and in what order.
 *
 * The list comes from the ledger the Provisioner wrote, read in reverse. Deleting in
 * reverse creation order means an IAM binding goes before the service account it names,
 * and a service before the key it used — never the other way round, which would leave a
 * dangling grant nobody can see any more.
 *
 * Reconstructing names from the agent id was considered and rejected: a provisioning
 * run that died partway created some of them and not others, and only the ledger knows
 * which.
 */
export function deletionOrder(record: DedicatedResourceRecord): CreatedResource[] {
  return [...record.created].filter((entry) => !entry.deleted_at).reverse();
}

export async function markDeleted(input: {
  documents: DocumentStore;
  agentId: string;
  name: string;
  now: () => number;
}): Promise<void> {
  const record = await input.documents.get<DedicatedResourceRecord>('dedicated_resources', input.agentId);
  if (!record) return;
  // Written per resource, not in one batch at the end: a run that dies halfway must
  // leave a ledger that says exactly what is still out there.
  await input.documents.update('dedicated_resources', input.agentId, {
    created: record.created.map((entry) =>
      entry.name === input.name ? { ...entry, deleted_at: new Date(input.now()).toISOString() } : entry),
  });
}

export async function releaseIfDone(input: {
  documents: DocumentStore;
  agentId: string;
}): Promise<boolean> {
  const record = await input.documents.get<DedicatedResourceRecord>('dedicated_resources', input.agentId);
  if (!record) return false;
  if (record.created.some((entry) => !entry.deleted_at)) return false;
  // The document itself stays: the sweep and the audit both read it afterwards.
  await input.documents.update('dedicated_resources', input.agentId, { status: 'RELEASED' });
  return true;
}

export { assertRuntimeName };
