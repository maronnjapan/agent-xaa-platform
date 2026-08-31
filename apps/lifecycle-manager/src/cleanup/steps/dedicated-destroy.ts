import { assertRuntimeName, shortId } from '@xaa/contracts';
import { deletionOrder, markDeleted, releaseIfDone, type DedicatedResourceRecord } from '../../dedicated.js';
import type { CleanupContext } from '../../clients/types.js';

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
    assertRuntimeName(guardedName(resource.kind, resource.name));
    await destroy(context, resource.kind, resource.name);
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
    assertRuntimeName(guardedName(resource.kind, resource.name));
    await context.clients.iam.deleteServiceAccount(resource.name);
    await markDeleted({ documents: context.documents, agentId: context.domain.agent_id, name: resource.name, now: context.now });
  }
  await releaseIfDone({ documents: context.documents, agentId: context.domain.agent_id });
  return 'succeeded';
}

/**
 * What the name check should look at.
 *
 * A binding is recorded as `resource|role|member`, and the thing being protected is the
 * resource it sits on — the role and the member are not names in the runtime space at
 * all. Checking the whole string would reject every binding; checking the resource is
 * the question actually worth asking.
 */
function guardedName(kind: string, name: string): string {
  return kind === 'iam_binding' ? name.split('|')[0]! : name;
}

async function destroy(context: CleanupContext, kind: string, name: string): Promise<void> {
  if (kind === 'cloud_run_job') { await context.clients.cloudRun.deleteJob(name); return; }
  if (kind === 'cloud_run_service') { await context.clients.cloudRun.deleteService(name); return; }
  if (kind === 'crypto_key') {
    await context.clients.kms.destroyCryptoKeyVersion(`${name}/cryptoKeyVersions/1`);
    await context.clients.jwks.deleteKey(`keys/idjag-${shortId(context.domain.agent_id)}-1.json`).catch(() => undefined);
    return;
  }
  if (kind === 'iam_binding') { await context.clients.iam.removeBinding(name); return; }
}

export const NO_DEDICATED_RESOURCES = 'no_dedicated_resources';
