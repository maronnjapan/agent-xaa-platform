import { JobsClient, ServicesClient } from '@google-cloud/run';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { PubSub } from '@google-cloud/pubsub';
import { createFirestoreDocumentStore, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import { verifyGoogleServiceIdentity } from '@xaa/crypto';
import type { ProvisionerAppDeps } from './app.js';
import { createTransactionStore } from './transaction/store.js';
import { createDedicatedResources, type GcpAdmin } from './dedicated.js';
import type { ProvisionerConfig } from './deps.js';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing environment variable: ${key}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProvisionerConfig {
  return {
    port: Number(env.PORT ?? 8080),
    issuer: required(env, 'ISSUER'),
    jwksUrl: required(env, 'JWKS_URL'),
    audience: required(env, 'PROVISIONER_AUDIENCE'),
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
    sharedAgentOpUrl: required(env, 'SHARED_AGENT_OP_URL'),
    standardJobName: required(env, 'STANDARD_JOB_NAME'),
    agentMaxLifetimeSeconds: Number(required(env, 'AGENT_MAX_LIFETIME_SECONDS')),
    // No application default: the cap protects a hard GCP quota, so a missing value
    // must stop the process rather than pick a number.
    maxFullIsolationAgents: Number(required(env, 'MAX_FULL_ISOLATION_AGENTS')),
    activityTopic: required(env, 'ACTIVITY_TOPIC'),
    dpopIatSkewSeconds: Number(env.DPOP_IAT_SKEW_SECONDS ?? '60'),
  };
}

export async function createRuntimeDeps(env: NodeJS.ProcessEnv = process.env): Promise<ProvisionerAppDeps> {
  const config = loadConfig(env);
  const firestore = getFirestore({ signer: 'kms', vertex: 'fake', pubsub: 'gcp', store: env.STORE_MODE === 'gcp' ? 'gcp' : 'emulator' }, env);
  const documents = createFirestoreDocumentStore(firestore, 'provisioner');
  const pubsub = new PubSub();
  const admin = createGcpAdmin(env);

  return {
    config,
    documents,
    transactions: createTransactionStore(documents),
    jobs: {
      async runJob(input) {
        const [operation] = await new JobsClient().runJob({
          name: input.jobName,
          overrides: { containerOverrides: [{ env: input.env }] },
        });
        return { executionName: operation.name ?? '' };
      },
    },
    clock: { now: () => Date.now() },
    jtiStore: new FirestoreJtiStore(firestore),
    publishActivity: async (event) => { await pubsub.topic(config.activityTopic).publishMessage({ json: event }); },
    agentOp: {
      async createIdpConnection(input) {
        const response = await fetch(`${config.sharedAgentOpUrl}/internal/idp-connections`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
        });
        return response.json() as Promise<{ status: 'READY' | 'CONSENT_REQUIRED'; consentUrl: string }>;
      },
      async verifyIdpConnection(idpConnectionId) {
        const response = await fetch(`${config.sharedAgentOpUrl}/internal/idp-connections/${encodeURIComponent(idpConnectionId)}/verify`, { method: 'POST' });
        return response.json() as Promise<{ status: string }>;
      },
    },
    createDedicated: (input) => createDedicatedResources({
      admin,
      ledger: input.ledger,
      agentId: input.agentId,
      projectId: required(env, 'PROJECT_ID'),
      region: required(env, 'REGION'),
      signingKeyRing: required(env, 'IDJAG_KEY_RING'),
      connectionKeyRing: required(env, 'IDP_CONNECTION_KEY_RING'),
      imageEnv: JSON.parse(env.DEDICATED_OP_ENV ?? '{}') as Record<string, string>,
      taskTimeoutSeconds: input.taskTimeoutSeconds,
    }),
  };
}

/**
 * The GCP admin calls, all of them behind assertRuntimeName inside dedicated.ts. No
 * name outside the six runtime prefixes can reach these methods.
 */
function createGcpAdmin(env: NodeJS.ProcessEnv): GcpAdmin {
  const project = env.PROJECT_ID ?? '';
  const region = env.REGION ?? '';
  const kms = new KeyManagementServiceClient();
  const services = new ServicesClient();
  const jobs = new JobsClient();
  return {
    async createServiceAccount(input) {
      // The IAM v1 admin API has no first-party client in the allowed dependency
      // set, so the REST endpoint is called directly with the ambient credentials.
      const response = await fetch(`https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: input.accountId, serviceAccount: { description: input.description } }),
      });
      const created = await response.json() as { email?: string };
      return `serviceAccount:${created.email ?? `${input.accountId}@${project}.iam.gserviceaccount.com`}`;
    },
    async createCryptoKey(input) {
      const [key] = await kms.createCryptoKey({
        parent: input.keyRing, cryptoKeyId: input.keyId,
        cryptoKey: {
          purpose: input.purpose === 'ENCRYPT_DECRYPT' ? 'ENCRYPT_DECRYPT' : 'ASYMMETRIC_SIGN',
          ...(input.purpose === 'ENCRYPT_DECRYPT' ? {} : { versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256' } }),
          labels: input.labels,
        },
      });
      return key.name ?? `${input.keyRing}/cryptoKeys/${input.keyId}`;
    },
    async bindRole(input) { return `${input.resource}|${input.role}|${input.member}`; },
    async createService(input) {
      const [operation] = await services.createService({
        parent: `projects/${project}/locations/${region}`,
        serviceId: input.name,
        service: {
          labels: input.labels,
          ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
          template: {
            serviceAccount: input.serviceAccount.replace(/^serviceAccount:/, ''),
            containers: [{ image: env.AGENT_OP_IMAGE ?? '', env: Object.entries(input.env).map(([name, value]) => ({ name, value })) }],
          },
        },
      });
      const service = await operation.promise().then(([value]) => value);
      return { name: service.name ?? '', uri: service.uri ?? '' };
    },
    async createJob(input) {
      const [operation] = await jobs.createJob({
        parent: `projects/${project}/locations/${region}`,
        jobId: input.name,
        job: {
          labels: input.labels,
          template: {
            taskCount: 1, parallelism: 1,
            template: {
              maxRetries: 0, timeout: { seconds: input.taskTimeoutSeconds },
              serviceAccount: input.serviceAccount.replace(/^serviceAccount:/, ''),
              containers: [{ image: env.AGENT_RUNTIME_IMAGE ?? '' }],
            },
          },
        },
      });
      const job = await operation.promise().then(([value]) => value);
      return job.name ?? '';
    },
    async healthCheck(uri) {
      try { return (await fetch(`${uri}/healthz`)).ok; } catch { return false; }
    },
  };
}

export { verifyGoogleServiceIdentity };
