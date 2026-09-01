import { InMemoryJtiStore } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import type { ActivityEvent } from '@xaa/contracts';
import createApp, { type LifecycleDeps } from '../index.js';
import type { CleanupClients } from '../clients/types.js';
import type { LifecycleConfig } from '../config.js';
import type { LabelledResource } from '../sweep.js';

export const LIFECYCLE_BASE = 'https://lifecycle.test';
export const ISSUER = 'https://human-idp.test';
export const AGENT_OP_URL = 'https://shared-agent-op.test';

export const testConfig: LifecycleConfig = {
  projectId: 'xaa-test', region: 'asia-northeast1', firestoreDatabaseId: 'xaa',
  issuer: ISSUER, selfAudience: 'lifecycle-manager',
  platformEndpointsUri: 'gs://xaa-config/platform-endpoints.json',
  agentMaxLifetimeSeconds: 86_400, expiringWindowSeconds: 60,
  pubsubMode: 'inproc', storeMode: 'emulator',
};

export interface RecordedCall { target: string; argument: string }

/**
 * Every outbound effect, recorded rather than performed.
 *
 * Cleanup is judged by what it asked for and in what order, so the doubles record and
 * return; `failAt` injects the one failure a test is about, which is how the
 * "continues after a failing step" cases are written without eleven bespoke stubs.
 */
export function recordingClients(options: {
  failAt?: string;
  bridgeUrl?: string | null;
  statusFor?: Record<string, number>;
} = {}): CleanupClients & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record = (target: string, argument: string): void => {
    calls.push({ target, argument });
    if (options.failAt === target) throw new Error(`${target} failed`);
  };
  const status = (target: string): number => options.statusFor?.[target] ?? 200;
  return {
    calls,
    cloudRun: {
      async cancelExecution(name) { record('cancelExecution', name); return 'cancelled'; },
      async deleteService(name) { record('deleteService', name); return 'deleted'; },
      async deleteJob(name) { record('deleteJob', name); return 'deleted'; },
    },
    kms: {
      async destroyCryptoKeyVersion(name) { record('destroyCryptoKeyVersion', name); return 'scheduled'; },
    },
    iam: {
      async deleteServiceAccount(name) { record('deleteServiceAccount', name); return 'deleted'; },
      async removeBinding(name) { record('removeBinding', name); return 'removed'; },
    },
    jwks: { async deleteKey(name) { record('deleteKey', name); } },
    agentOp: {
      async disableIssuance({ agentId }) { record('disableIssuance', agentId); return status('disableIssuance'); },
      async revokeIdpConnection({ connectionId }) { record('revokeIdpConnection', connectionId); return status('revokeIdpConnection'); },
      async revokeClientCredential({ agentId }) { record('revokeClientCredential', agentId); return status('revokeClientCredential'); },
      async deleteRegistration({ agentId }) { record('deleteRegistration', agentId); return status('deleteRegistration'); },
    },
    resourceAs: {
      async revokeByActor({ baseUrl, actorSub }) { record('revokeByActor', `${baseUrl}|${actorSub}`); return status(`revokeByActor:${baseUrl}`); },
    },
    bridge: {
      async disableBindings({ agentId }) { record('disableBindings', agentId); return status('disableBindings'); },
      async deleteBindings({ agentId }) { record('deleteBindings', agentId); return status('deleteBindings'); },
      async revokeUpstream({ connectionId }) { record('revokeUpstream', connectionId); return status('revokeUpstream'); },
    },
    endpoints: {
      agentOpUrl: AGENT_OP_URL,
      docsAsUrl: 'https://resource-docs-as.test',
      financeAsUrl: 'https://resource-finance-as.test',
      bridgeUrl: options.bridgeUrl === undefined ? null : options.bridgeUrl,
    },
  };
}

export interface LifecycleHarness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  documents: DocumentStore;
  provisionerStore: DocumentStore;
  clients: ReturnType<typeof recordingClients>;
  activity: ActivityEvent[];
  auditLines: string[];
  logs: string[];
  provisionerCalls: Array<Record<string, unknown>>;
  deletedResources: LabelledResource[];
  deps: LifecycleDeps;
}

export function createLifecycleHarness(options: {
  idpPublicJwk?: JsonWebKey;
  clients?: ReturnType<typeof recordingClients>;
  now?: () => number;
  shared?: ReturnType<typeof createFirestoreDouble>;
  allowedCallers?: string[];
  callerEmail?: string;
  labelled?: LabelledResource[];
  newAgentId?: string;
} = {}): LifecycleHarness {
  const firestore = options.shared ?? createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'lifecycle-manager');
  const provisionerStore = createFirestoreDocumentStore(firestore, 'provisioner');
  const clients = options.clients ?? recordingClients();
  const activity: ActivityEvent[] = [];
  const auditLines: string[] = [];
  const logs: string[] = [];
  const provisionerCalls: Array<Record<string, unknown>> = [];
  const deletedResources: LabelledResource[] = [];

  const deps: LifecycleDeps = {
    config: testConfig,
    documents,
    clients,
    provisioner: {
      async reprovision({ body }) {
        provisionerCalls.push(body);
        return { status: 201, body: { agent_id: options.newAgentId ?? 'agent-nnnnnnnnnnnnnnnnnnnnnnnnnn' } };
      },
    },
    provisionerUrl: 'https://provisioner.test',
    accessToken: {
      issuer: ISSUER, jwksUrl: `${ISSUER}/jwks.json`, audience: 'lifecycle-manager',
      requiredScope: 'agent:revoke', iatSkewSeconds: 300, jtiStore: new InMemoryJtiStore(),
      expectedHtu: (request: Request) => `${LIFECYCLE_BASE}${new URL(request.url).pathname}`,
    } as LifecycleDeps['accessToken'],
    // The Access Token is signed by the Human IdP's key, so the guard's JWK Set is that.
    fetchImpl: (async () => Response.json({
      keys: [{ ...(options.idpPublicJwk ?? {}), kid: 'idp-testkey', alg: 'ES256', use: 'sig' }],
    })) as unknown as typeof fetch,
    internalAuth: {
      audience: LIFECYCLE_BASE,
      // Full emails, as Terraform injects them: the check is membership, not a prefix.
      allowedCallers: options.allowedCallers ?? [
        'sa-scheduler@xaa-test.iam.gserviceaccount.com',
        'sa-security@xaa-test.iam.gserviceaccount.com',
        'sa-authorization@xaa-test.iam.gserviceaccount.com',
      ],
      verify: async (token) => (token === 'invalid' ? null : options.callerEmail ?? 'sa-scheduler@xaa-test.iam.gserviceaccount.com'),
    },
    logger: createLogger('lifecycle-manager', 'provisioner', (line) => logs.push(line)),
    ...(options.now ? { now: options.now } : {}),
    auditWrite: (line) => auditLines.push(line),
    publishActivity: async (event) => { activity.push(event); },
    ...(options.labelled
      ? {
          sweepExtras: {
            listLabelledResources: async () => options.labelled!,
            deleteResource: async (resource) => { deletedResources.push(resource); },
          },
        }
      : {}),
  };

  const app = createApp(deps);
  return {
    documents, provisionerStore, clients, activity, auditLines, logs, provisionerCalls, deletedResources, deps,
    fetch: async (path, init) => app.fetch(new Request(new URL(path, LIFECYCLE_BASE), init)),
  };
}

/** A registration in the shape the Provisioner writes and Cleanup reads. */
export async function seedDomain(harness: LifecycleHarness, options: {
  agentId?: string;
  humanSubject?: string;
  status?: string;
  isolationLevel?: 'standard' | 'full_isolation';
  expiresAt?: string;
  jobExecutionName?: string | null;
  idpConnectionId?: string | null;
  bridgeBindingIds?: string[];
  cleanupStepResults?: unknown[];
  cleanupReason?: string;
} = {}): Promise<string> {
  const agentId = options.agentId ?? 'agent-abcdefghijklmnopqrstuvwxyz';
  const isolation = options.isolationLevel ?? 'standard';
  await harness.provisionerStore.set('agents', `${agentId}__meta`, {
    agent_id: agentId,
    human_subject: options.humanSubject ?? 'testuser',
    isolation_level: isolation,
    registration_id: `reg-${agentId}`,
    kms_key_name: 'projects/xaa-test/locations/asia-northeast1/keyRings/idjag-signing/cryptoKeys/shared',
    dedicated_op: isolation === 'standard' ? null : 'https://dedicated-op-abcdefghijkl.test',
    job_execution_name: options.jobExecutionName === undefined
      ? 'projects/xaa-test/locations/asia-northeast1/jobs/agent-runtime-standard/executions/exec-1'
      : options.jobExecutionName,
    idp_connection_id: options.idpConnectionId === undefined ? `idpconn-${agentId}` : options.idpConnectionId,
    bridge_binding_ids: options.bridgeBindingIds ?? [],
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    status: options.status ?? 'ACTIVE',
    cleanup_step_results: options.cleanupStepResults ?? [],
    ...(options.cleanupReason ? { cleanup_reason: options.cleanupReason } : {}),
  });
  return agentId;
}
