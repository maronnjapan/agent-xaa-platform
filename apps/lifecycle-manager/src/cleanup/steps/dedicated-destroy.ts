import { assertRuntimeName } from '@xaa/contracts';
import { deletionOrder, markDeleted, releaseIfDone, type DedicatedResourceRecord } from '../../dedicated.js';
import type { CleanupClients, CleanupContext } from '../../clients/types.js';

/**
 * step8. Removes the four kinds of resource a FULL_ISOLATION agent was given.
 *
 * Every name passes `assertRuntimeName` before any API is called. The six runtime
 * prefixes are the whole of what runtime code may touch (DEC-IAC-08); a ledger that
 * somehow named `human-idp` would raise rather than delete, and nothing would be sent.
 * That check is the difference between a cleanup bug and an outage.
 *
 * A KMS CryptoKey cannot be deleted — GCP does not allow it. The versions are scheduled
 * for destruction instead, which stops both their use and their cost, and an empty key
 * is left in the ring (DEC-IAC-25). The published JWKS entry goes with them, so a
 * verifier does not keep a key it can no longer trust.
 */
export async function dedicatedDestroy(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  if (context.domain.isolation_level !== 'full_isolation') return 'skipped';
  const record = await context.documents.get<DedicatedResourceRecord>('dedicated_resources', context.domain.agent_id);
  if (!record) return 'skipped';

  for (const resource of deletionOrder(record)) {
    if (resource.kind === 'service_account') continue;
    await destroyRuntimeResource(context.clients, resource.kind, resource.name);
    await markDeleted({ documents: context.documents, agentId: context.domain.agent_id, name: resource.name, now: context.now });
  }
  await releaseIfDone({ documents: context.documents, agentId: context.domain.agent_id });
  return 'succeeded';
}

/**
 * step9. Removes the service accounts, last.
 *
 * Their ids cannot be reused for thirty days, which is fine: `<short>` comes from the
 * agent id's random part, so a new agent never wants the name an old one held.
 */
export async function dedicatedSaDelete(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  if (context.domain.isolation_level !== 'full_isolation') return 'skipped';
  const record = await context.documents.get<DedicatedResourceRecord>('dedicated_resources', context.domain.agent_id);
  if (!record) return 'skipped';

  for (const resource of deletionOrder(record)) {
    if (resource.kind !== 'service_account') continue;
    await destroyRuntimeResource(context.clients, resource.kind, resource.name);
    await markDeleted({ documents: context.documents, agentId: context.domain.agent_id, name: resource.name, now: context.now });
  }
  await releaseIfDone({ documents: context.documents, agentId: context.domain.agent_id });
  return 'succeeded';
}

/**
 * What the name check should look at.
 *
 * A binding is recorded as `resource|role|member`. Some bindings intentionally sit on
 * shared project, bucket or topic resources, so the runtime namespace guard applies to
 * the member being removed. Removing a runtime-only member from a shared policy cannot
 * revoke a Terraform-managed service account, while accepting an arbitrary member
 * could.
 */
function guardedName(kind: string, name: string): string {
  if (kind !== 'iam_binding') return name;
  const [, , member] = name.split('|');
  if (!member?.startsWith('serviceAccount:')) throw new Error('invalid IAM binding ledger entry');
  return member.slice('serviceAccount:'.length).split('@')[0]!;
}

/**
 * Removing one runtime resource, whatever found it.
 *
 * The ledger walk above and the sweep's orphan collection (T-LIFE-10 stage (e)) delete
 * exactly the same things by exactly the same rules; the only difference is how the
 * name was discovered. One implementation means the `assertRuntimeName` guard and the
 * "a CryptoKey's versions are scheduled, never the key itself" rule cannot drift apart
 * between the two callers.
 *
 * A runtime key is created once and never rotated, so version 1 is all there is. The
 * published JWKS entry is derived from the key's own name rather than from the agent
 * id, so this works for a resource whose ledger row was never written.
 */
export async function destroyRuntimeResource(
  clients: Pick<CleanupClients, 'cloudRun' | 'kms' | 'iam' | 'jwks'>, kind: string, name: string,
): Promise<void> {
  assertRuntimeName(guardedName(kind, name));
  if (kind === 'cloud_run_job') { await clients.cloudRun.deleteJob(name); return; }
  if (kind === 'cloud_run_service') { await clients.cloudRun.deleteService(name); return; }
  if (kind === 'service_account') { await clients.iam.deleteServiceAccount(name); return; }
  if (kind === 'crypto_key') {
    await clients.kms.destroyCryptoKeyVersion(`${name}/cryptoKeyVersions/1`);
    const leaf = name.split('/').pop() ?? name;
    // Only the signing key is published; the connection key never had a JWKS entry.
    if (leaf.startsWith('idjag-')) await clients.jwks.deleteKey(`keys/${leaf}-1.json`).catch(() => undefined);
    return;
  }
  if (kind === 'iam_binding') { await clients.iam.removeBinding(name); return; }
}

export const NO_DEDICATED_RESOURCES = 'no_dedicated_resources';
