import { describe, expect, it } from 'vitest';
import { assertRuntimeName, dedicatedNames, ForbiddenRuntimeName, runtimeDescription, runtimeLabels, shortId } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createDedicatedResources, DedicatedProvisioningTimeout, type GcpAdmin } from '../src/dedicated.js';
import { createDedicatedLedger } from '../src/dedicated-ledger.js';
import { recordingAdmin, type AdminCall } from './helpers.js';

/**
 * DEC-IAC-07. A FULL_ISOLATION agent gets its own OP, its own two keys, its own two
 * service accounts and its own runtime job — created now and gone within a day.
 *
 * None of it is in Terraform. The reproducibility Terraform buys is worth nothing for
 * a resource whose whole life is shorter than a plan-and-apply cycle, and a fixed
 * pre-created pool would both cap concurrency and leave idle identities standing.
 *
 * The order is the interesting part. Identities exist before the keys they are granted
 * on; the grants exist before the workloads that need them; the OP answers a health
 * check before the job that will call it is created. Each of those is a dependency, and
 * a run that reordered them would fail intermittently — IAM propagation being slow
 * enough to sometimes hide the mistake.
 */
const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

function ledgerFor() {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'provisioner');
  return { documents, ledger: createDedicatedLedger(documents, () => Date.parse('2026-03-01T00:00:00Z')) };
}

async function build(admin: GcpAdmin & { calls: AdminCall[] } = recordingAdmin()) {
  const { documents, ledger } = ledgerFor();
  await ledger.open(AGENT_ID, '2026-03-01T08:00:00Z');
  let clock = Date.parse('2026-03-01T00:00:00Z');
  const result = await createDedicatedResources({
    admin, ledger, agentId: AGENT_ID,
    projectId: 'xaa-test', region: 'asia-northeast1',
    signingKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idjag-signing',
    connectionKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idp-connection-encryption',
    imageEnv: {}, runtimeEnv: {}, jwksBucket: 'xaa-test-jwks', activityTopic: 'agent-activity-stream',
    runtimeInvokerServices: ['projects/xaa-test/locations/asia-northeast1/services/resource-docs-as'],
    provisionerMember: 'serviceAccount:sa-provisioner@xaa-test.iam.gserviceaccount.com',
    agentPlatformClientSecret: 'projects/xaa-test/secrets/client-secret',
    taskTimeoutSeconds: 28_800,
    now: () => { clock += 10_000; return clock; },
    sleep: async () => undefined,
  });
  return { admin, documents, ledger, result };
}

describe('creating the dedicated resources of a FULL_ISOLATION agent', () => {
  it('creates the six resources in the order their dependencies require', async () => {
    const { admin, result } = await build();
    const names = dedicatedNames(AGENT_ID);

    expect(admin.calls.filter((call) => call.method !== 'bindRole')).toEqual([
      { method: 'createServiceAccount', name: names.opServiceAccount },
      { method: 'createServiceAccount', name: names.agentServiceAccount },
      { method: 'createCryptoKey', name: names.signingKey },
      { method: 'createCryptoKey', name: names.connectionKey },
      { method: 'createService', name: names.opService },
      { method: 'createJob', name: names.runtimeJob },
    ]);
    // The grants sit between the identities and the workloads: after both keys exist
    // and before the service that has to use them.
    const firstBinding = admin.calls.findIndex((call) => call.method === 'bindRole');
    expect(firstBinding).toBeGreaterThan(admin.calls.findIndex((call) => call.method === 'createCryptoKey'));
    expect(firstBinding).toBeLessThan(admin.calls.findIndex((call) => call.method === 'createService'));
    expect(result.runtimeJobName).toContain(names.runtimeJob);
  });

  it('records every one of them in the ledger, with the fully qualified name', async () => {
    const { ledger } = await build();
    const record = (await ledger.read(AGENT_ID))!;
    expect(record.created.filter((entry) => entry.kind === 'service_account')).toHaveLength(2);
    expect(record.created.filter((entry) => entry.kind === 'crypto_key')).toHaveLength(2);
    expect(record.created.filter((entry) => entry.kind === 'cloud_run_service')).toHaveLength(1);
    expect(record.created.filter((entry) => entry.kind === 'cloud_run_job')).toHaveLength(1);
    expect(new Set(record.created.map((entry) => entry.kind))).toEqual(new Set([
      'service_account', 'crypto_key', 'iam_binding', 'cloud_run_service', 'cloud_run_job',
    ]));
    // Fully qualified, never a short name: cleanup deletes what this says and must not
    // have to know the naming rule that was in force when the agent was made.
    for (const entry of record.created) expect(entry.name).toContain('/');
  });

  it('labels everything it creates so the sweep can find it later', async () => {
    const base = recordingAdmin();
    const labelled: Array<Record<string, string>> = [];
    const descriptions: string[] = [];
    const watching: GcpAdmin & { calls: AdminCall[] } = {
      ...base,
      async createServiceAccount(input) { descriptions.push(input.description); return base.createServiceAccount(input); },
      async createCryptoKey(input) { labelled.push(input.labels); return base.createCryptoKey(input); },
      async createService(input) { labelled.push(input.labels); return base.createService(input); },
      async createJob(input) { labelled.push(input.labels); return base.createJob(input); },
    };
    await build(watching);

    expect(labelled).toHaveLength(4);
    for (const labels of labelled) expect(labels).toEqual(runtimeLabels(AGENT_ID));
    expect(runtimeLabels(AGENT_ID)).toEqual({ 'xaa-managed': 'runtime', 'xaa-agent-id': AGENT_ID });
    // Service accounts carry no labels in GCP, so the same two facts go in the
    // description instead — a sweep that looked only at labels would miss them.
    expect(descriptions).toEqual([runtimeDescription(AGENT_ID), runtimeDescription(AGENT_ID)]);
    expect(runtimeDescription(AGENT_ID)).toContain('xaa-managed=runtime');
  });

  it('leaves the ledger listing exactly what was built when a step fails partway', async () => {
    const { documents, ledger } = ledgerFor();
    await ledger.open(AGENT_ID, '2026-03-01T08:00:00Z');
    await expect(createDedicatedResources({
      admin: recordingAdmin({ failAt: 'createCryptoKey' }), ledger, agentId: AGENT_ID,
      projectId: 'xaa-test', region: 'asia-northeast1',
      signingKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idjag-signing',
      connectionKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idp-connection-encryption',
      imageEnv: {}, runtimeEnv: {}, jwksBucket: 'b', activityTopic: 't', runtimeInvokerServices: [],
      provisionerMember: 'serviceAccount:sa@x.test', agentPlatformClientSecret: 'projects/p/secrets/s',
      taskTimeoutSeconds: 3600, now: () => 0, sleep: async () => undefined,
    })).rejects.toThrow();

    const record = await documents.get<{ created: Array<{ kind: string }> }>('dedicated_resources', AGENT_ID);
    // The two service accounts, and nothing the failing step half-made.
    expect(record!.created).toHaveLength(2);
    expect(record!.created.every((entry) => entry.kind === 'service_account')).toBe(true);
  });

  it('gives up rather than handing over an OP that never answered', async () => {
    const { ledger } = ledgerFor();
    await ledger.open(AGENT_ID, '2026-03-01T08:00:00Z');
    const admin = recordingAdmin();
    let clock = 0;
    // IAM takes minutes to propagate, so the OP is polled rather than assumed ready.
    // An agent whose OP cannot sign yet would fail its first exchange for no visible
    // reason; failing here is a failure with a cause attached.
    await expect(createDedicatedResources({
      admin: { ...admin, async healthCheck() { return false; } }, ledger, agentId: AGENT_ID,
      projectId: 'xaa-test', region: 'asia-northeast1',
      signingKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idjag-signing',
      connectionKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idp-connection-encryption',
      imageEnv: {}, runtimeEnv: {}, jwksBucket: 'b', activityTopic: 't', runtimeInvokerServices: [],
      provisionerMember: 'serviceAccount:sa@x.test', agentPlatformClientSecret: 'projects/p/secrets/s',
      taskTimeoutSeconds: 3600,
      now: () => { clock += 10_000; return clock; },
      sleep: async () => undefined,
    })).rejects.toThrow(DedicatedProvisioningTimeout);
  });
});

describe('the runtime name space', () => {
  it('refuses a Terraform-managed name and accepts a dedicated one', () => {
    expect(() => assertRuntimeName('human-idp')).toThrow(ForbiddenRuntimeName);
    expect(() => assertRuntimeName('dedicated-op-abc123def456')).not.toThrow();
    expect(shortId(AGENT_ID)).toHaveLength(12);
    expect(dedicatedNames(AGENT_ID).opService).toBe(`dedicated-op-${shortId(AGENT_ID)}`);
  });
});
