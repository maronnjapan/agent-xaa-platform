import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { ForbiddenRuntimeName } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import { cleanupAgent } from '../src/cleanup/index.js';
import { NO_DEDICATED_RESOURCES } from '../src/cleanup/steps/dedicated-destroy.js';
import { deletionOrder, type DedicatedResourceRecord } from '../src/dedicated.js';
import { createLifecycleHarness, recordingClients, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };
const logger = createLogger('lifecycle-manager', 'provisioner', () => {});

function deps(harness: LifecycleHarness) {
  return { documents: harness.documents, clients: harness.clients, logger, logContext };
}

const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
const SHORT = AGENT_ID.slice(-12);

/** The ledger the Provisioner leaves behind, in creation order. */
async function seedLedger(harness: LifecycleHarness, names: Array<[DedicatedResourceRecord['created'][number]['kind'], string]>): Promise<void> {
  await harness.provisionerStore.set('dedicated_resources', AGENT_ID, {
    agent_id: AGENT_ID, status: 'READY', created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-02T00:00:00.000Z', last_error: null,
    created: names.map(([kind, name]) => ({ kind, name, created_at: '2026-01-01T00:00:00.000Z', deleted_at: null })),
  } satisfies DedicatedResourceRecord);
}

const FULL_LEDGER: Array<[DedicatedResourceRecord['created'][number]['kind'], string]> = [
  ['service_account', `sa-op-${SHORT}`],
  ['service_account', `sa-agent-${SHORT}`],
  ['crypto_key', `projects/p/locations/l/keyRings/idjag-signing/cryptoKeys/idjag-${SHORT}`],
  ['iam_binding', `projects/p/locations/l/keyRings/idjag-signing/cryptoKeys/idjag-${SHORT}|roles/cloudkms.signerVerifier|serviceAccount:sa-op-${SHORT}@p.iam.gserviceaccount.com`],
  ['cloud_run_service', `projects/p/locations/l/services/dedicated-op-${SHORT}`],
  ['cloud_run_job', `projects/p/locations/l/jobs/agent-runtime-${SHORT}`],
];

describe('destroying the dedicated resources', () => {
  it('deletes in reverse creation order', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { isolationLevel: 'full_isolation' });
    await seedLedger(harness, FULL_LEDGER);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));

    const order = harness.clients.calls
      .filter((entry) => ['deleteJob', 'deleteService', 'destroyCryptoKeyVersion', 'removeBinding', 'deleteServiceAccount'].includes(entry.target))
      .map((entry) => entry.target);
    // Job, service, binding, key: whatever depends on something goes before it.
    expect(order.slice(0, 4)).toEqual(['deleteJob', 'deleteService', 'removeBinding', 'destroyCryptoKeyVersion']);
    // Service accounts last, once nothing names them any more.
    expect(order.slice(4)).toEqual(['deleteServiceAccount', 'deleteServiceAccount']);
  });

  it('skips both steps for standard agents', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { isolationLevel: 'standard' });
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    for (const step of ['dedicated_destroy', 'dedicated_sa_delete']) {
      expect(outcome.results.find((entry) => entry.step === step)!.status).toBe('skipped');
    }
    expect(NO_DEDICATED_RESOURCES).toBe('no_dedicated_resources');
    for (const gcpCall of ['deleteJob', 'deleteService', 'deleteServiceAccount', 'destroyCryptoKeyVersion', 'removeBinding']) {
      expect(harness.clients.calls.filter((entry) => entry.target === gcpCall)).toHaveLength(0);
    }
  });

  it('is idempotent on a second run', async () => {
    const shared = (await import('@xaa/gcp')).createFirestoreDouble();
    const first = createLifecycleHarness({ shared });
    const agentId = await seedDomain(first, { isolationLevel: 'full_isolation' });
    await seedLedger(first, FULL_LEDGER);
    await cleanupAgent(agentId, 'EXPIRED', deps(first));

    // Every element is now marked deleted, so a fresh run has nothing to delete.
    const record = await first.documents.get<DedicatedResourceRecord>('dedicated_resources', agentId);
    expect(record!.status).toBe('RELEASED');
    expect(deletionOrder(record!)).toEqual([]);
  });

  it('refuses to delete a terraform-managed name', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { isolationLevel: 'full_isolation' });
    // A Terraform-managed service smuggled into the ledger.
    await seedLedger(harness, [['cloud_run_service', 'projects/p/locations/l/services/human-idp']]);
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'dedicated_destroy')!.status).toBe('failed');
    expect(harness.clients.calls.filter((entry) => entry.target === 'deleteService')).toHaveLength(0);
    expect(() => { throw new ForbiddenRuntimeName('human-idp'); }).toThrow(/runtime name space/);
  });

  it('schedules key version destruction and never deletes the key', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { isolationLevel: 'full_isolation' });
    await seedLedger(harness, [['crypto_key', `projects/p/locations/l/keyRings/idjag-signing/cryptoKeys/idjag-${SHORT}`]]);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    const destroy = harness.clients.calls.find((entry) => entry.target === 'destroyCryptoKeyVersion')!;
    expect(destroy.argument).toContain('/cryptoKeyVersions/1');
    // A KMS CryptoKey cannot be deleted at all; the published JWKS entry goes instead.
    expect(harness.clients.calls.some((entry) => entry.target === 'deleteCryptoKey')).toBe(false);
    expect(harness.clients.calls.find((entry) => entry.target === 'deleteKey')!.argument)
      .toBe(`keys/idjag-${SHORT}-1.json`);
  });

  it('marks each resource deleted as it goes', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ failAt: 'deleteService' }) });
    const agentId = await seedDomain(harness, { isolationLevel: 'full_isolation' });
    await seedLedger(harness, FULL_LEDGER);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    const record = await harness.documents.get<DedicatedResourceRecord>('dedicated_resources', agentId);
    // The job was deleted before the service failed, and the ledger says so.
    expect(record!.created.find((entry) => entry.kind === 'cloud_run_job')!.deleted_at).toBeTruthy();
    expect(record!.created.find((entry) => entry.kind === 'cloud_run_service')!.deleted_at).toBeNull();
    expect(record!.status).not.toBe('RELEASED');
  });

  it('passes the runtime mutation scope check', () => {
    expect(() => execFileSync('bash', ['infra/tests/runtime-mutation-scope.sh'], { cwd: repoRoot })).not.toThrow();
  });
});
