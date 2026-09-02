import { describe, expect, it } from 'vitest';
import type { JobsClient, ServicesClient } from '@google-cloud/run';
import type { KeyManagementServiceClient } from '@google-cloud/kms';
import type { GoogleAuth } from 'google-auth-library';
import { ForbiddenRuntimeName, runtimeDescription, runtimeLabels } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import { cleanupAgent } from '../src/cleanup/index.js';
import { createOrphanCollector } from '../src/clients/orphans.js';
import { sweep } from '../src/sweep.js';
import { createLifecycleHarness, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';
import type { DedicatedResourceRecord } from '../src/dedicated.js';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };
const HOUR = 3_600_000;
const PROJECT = 'xaa-test';
const REGION = 'asia-northeast1';
const PARENT = `projects/${PROJECT}/locations/${REGION}`;

const LIVE_AGENT = 'agent-abcdefghijklmnopqrstuvwxyz';
const GONE_AGENT = 'agent-gonegonegonegonegonegone';

/**
 * The Google APIs as they answer: `[items]` from the client libraries, and a REST body
 * for IAM, which has no client library here. Only the two fields the collector reads
 * are modelled — a fuller double would be describing the SDK rather than our use of it.
 */
function googleDoubles(options: { services?: unknown[]; jobs?: unknown[]; keys?: unknown[]; accounts?: unknown[] } = {}) {
  const parents: string[] = [];
  const record = <T>(parent: string, items: T[]): [T[]] => { parents.push(parent); return [items]; };
  return {
    parents,
    services: { listServices: async ({ parent }: { parent: string }) => record(parent, options.services ?? []) } as unknown as ServicesClient,
    jobs: { listJobs: async ({ parent }: { parent: string }) => record(parent, options.jobs ?? []) } as unknown as JobsClient,
    kms: { listCryptoKeys: async ({ parent }: { parent: string }) => record(parent, options.keys ?? []) } as unknown as KeyManagementServiceClient,
    auth: {
      request: async ({ url }: { url: string }) => {
        parents.push(url);
        return { data: { accounts: options.accounts ?? [] } };
      },
    } as unknown as GoogleAuth,
  };
}

function collectorFor(harness: LifecycleHarness, doubles: ReturnType<typeof googleDoubles>) {
  return createOrphanCollector({
    projectId: PROJECT, region: REGION, clients: harness.clients,
    services: doubles.services, jobs: doubles.jobs, kms: doubles.kms, auth: doubles.auth,
  });
}

/** The ledger the Provisioner writes for an agent whose creation ran to completion. */
async function seedLedger(harness: LifecycleHarness, agentId: string, name: string): Promise<void> {
  await harness.provisionerStore.set('dedicated_resources', agentId, {
    agent_id: agentId, status: 'READY', created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-02T00:00:00.000Z', last_error: null,
    created: [{ kind: 'cloud_run_service', name, created_at: '2026-01-01T00:00:00.000Z', deleted_at: null }],
  } satisfies DedicatedResourceRecord);
}

describe('collecting what nothing owns', () => {
  /**
   * The case the labels exist for. A Provisioner that dies between creating the Cloud
   * Run service and writing its ledger row leaves a live service that no document
   * mentions — so the ledger cannot be what decides, and the label is the only thing
   * left that says whose it was.
   */
  it('collects a labelled resource missing from the ledger and leaves a ledgered one alone', async () => {
    const orphan = `${PARENT}/services/dedicated-op-orphanabcdef`;
    const ledgered = `${PARENT}/services/dedicated-op-liveagentabc`;
    const harness = createLifecycleHarness();
    // One agent is alive and its resource is recorded; the other agent is gone and its
    // resource was never recorded at all.
    await seedDomain(harness, { agentId: LIVE_AGENT, expiresAt: new Date(Date.now() + HOUR).toISOString() });
    await seedLedger(harness, LIVE_AGENT, ledgered);

    const doubles = googleDoubles({
      services: [
        { name: orphan, labels: runtimeLabels(GONE_AGENT) },
        { name: ledgered, labels: runtimeLabels(LIVE_AGENT) },
      ],
    });
    const collector = collectorFor(harness, doubles);
    const deleted: string[] = [];

    const counters = await sweep({
      documents: harness.documents, expiringWindowSeconds: 60,
      cleanup: (id, reason) => cleanupAgent(id, reason, {
        documents: harness.documents, clients: harness.clients, logger, logContext,
      }),
      listLabelledResources: collector.listLabelledResources,
      deleteResource: async (resource) => {
        deleted.push(resource.name);
        await collector.deleteResource(resource);
      },
    });

    expect(counters.orphans_deleted).toBe(1);
    expect(deleted).toEqual([orphan]);
    // The live agent's service was never touched, ledger row and all.
    expect(harness.clients.calls.filter((entry) => entry.target === 'deleteService').map((entry) => entry.argument))
      .toEqual([orphan]);
    const record = await harness.documents.get<DedicatedResourceRecord>('dedicated_resources', LIVE_AGENT);
    expect(record!.created[0]!.deleted_at).toBeNull();
  });

  it('finds every kind the Provisioner creates, and nothing Terraform owns', async () => {
    const harness = createLifecycleHarness();
    const doubles = googleDoubles({
      services: [
        { name: `${PARENT}/services/dedicated-op-orphanabcdef`, labels: runtimeLabels(GONE_AGENT) },
        // Terraform's own service: no labels, so not a candidate.
        { name: `${PARENT}/services/human-idp`, labels: {} },
      ],
      jobs: [{ name: `${PARENT}/jobs/agent-runtime-orphanabcdef`, labels: runtimeLabels(GONE_AGENT) }],
      keys: [{ name: `${PARENT}/keyRings/idjag-signing/cryptoKeys/idjag-orphanabcdef`, labels: runtimeLabels(GONE_AGENT) }],
      accounts: [
        { email: `sa-op-orphanabcdef@${PROJECT}.iam.gserviceaccount.com`, description: runtimeDescription(GONE_AGENT) },
        // Terraform's own service account, described in prose rather than by the label.
        { email: `sa-lifecycle@${PROJECT}.iam.gserviceaccount.com`, description: 'the lifecycle manager' },
      ],
    });

    const found = await collectorFor(harness, doubles).listLabelledResources();

    expect(found.map((resource) => resource.kind).sort())
      .toEqual(['cloud_run_job', 'cloud_run_service', 'crypto_key', 'crypto_key', 'service_account'].sort());
    expect(found.every((resource) => resource.agentId === GONE_AGENT)).toBe(true);
    expect(found.map((resource) => resource.name)).not.toContain(`${PARENT}/services/human-idp`);
    expect(found.map((resource) => resource.name)).not.toContain(`sa-lifecycle@${PROJECT}.iam.gserviceaccount.com`);
    // Both key rings are asked, and Cloud Run is asked at the project's own location.
    expect(doubles.parents).toContain(`${PARENT}/keyRings/idjag-signing`);
    expect(doubles.parents).toContain(`${PARENT}/keyRings/idp-connection-encryption`);
    expect(doubles.parents.filter((parent) => parent === PARENT)).toHaveLength(2);
  });

  it('deletes each kind the way the ledger walk would', async () => {
    const harness = createLifecycleHarness();
    const collector = collectorFor(harness, googleDoubles());
    const key = `${PARENT}/keyRings/idjag-signing/cryptoKeys/idjag-orphanabcdef`;

    await collector.deleteResource({ name: `${PARENT}/jobs/agent-runtime-orphanabcdef`, kind: 'cloud_run_job', agentId: GONE_AGENT });
    await collector.deleteResource({ name: key, kind: 'crypto_key', agentId: GONE_AGENT });
    await collector.deleteResource({ name: `sa-op-orphanabcdef@${PROJECT}.iam.gserviceaccount.com`, kind: 'service_account', agentId: GONE_AGENT });

    expect(harness.clients.calls.map((entry) => entry.target))
      .toEqual(['deleteJob', 'destroyCryptoKeyVersion', 'deleteKey', 'deleteServiceAccount']);
    // A CryptoKey is never deleted, only its one version scheduled for destruction, and
    // the published JWKS entry goes with it (DEC-IAC-25).
    expect(harness.clients.calls.find((entry) => entry.target === 'destroyCryptoKeyVersion')!.argument)
      .toBe(`${key}/cryptoKeyVersions/1`);
    expect(harness.clients.calls.find((entry) => entry.target === 'deleteKey')!.argument)
      .toBe('keys/idjag-orphanabcdef-1.json');
  });

  it('refuses a name outside the runtime namespace even when the label says otherwise', async () => {
    const harness = createLifecycleHarness();
    const collector = collectorFor(harness, googleDoubles());
    // A listing cannot produce this, but a label anyone with project access can set
    // must not be what stands between a sweep and a Terraform-managed service.
    await expect(collector.deleteResource({
      name: `${PARENT}/services/human-idp`, kind: 'cloud_run_service', agentId: GONE_AGENT,
    })).rejects.toThrow(ForbiddenRuntimeName);
    expect(harness.clients.calls).toHaveLength(0);
  });

  it('collects nothing rather than throwing when a listing is refused', async () => {
    const harness = createLifecycleHarness();
    const refused = {
      parents: [],
      services: { listServices: async () => { throw new Error('permission denied'); } } as unknown as ServicesClient,
      jobs: { listJobs: async () => { throw new Error('permission denied'); } } as unknown as JobsClient,
      kms: { listCryptoKeys: async () => { throw new Error('permission denied'); } } as unknown as KeyManagementServiceClient,
      auth: { request: async () => { throw new Error('permission denied'); } } as unknown as GoogleAuth,
    };
    // A tick that threw here would lose the four stages that already ran.
    await expect(collectorFor(harness, refused).listLabelledResources()).resolves.toEqual([]);
  });
});
