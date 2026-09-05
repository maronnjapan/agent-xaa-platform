import { JobsClient, ServicesClient } from '@google-cloud/run';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { PubSub } from '@google-cloud/pubsub';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { assertRuntimeName, publishActivityEvent } from '@xaa/contracts';
import { createFirestoreDocumentStore, createIdentityTokenProvider, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import { verifyGoogleServiceIdentity } from '@xaa/crypto';
import type { ProvisionerAppDeps } from './app.js';
import { createAgentOpClient } from './agent/idp-connection.js';
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
    // Re-provisioning is asked for by Lifecycle and by nothing else. An unset variable
    // leaves the list empty, which refuses every caller rather than opening the route.
    internalCallers: (env.LIFECYCLE_SA_EMAIL ?? '').split(',').map((email) => email.trim()).filter(Boolean),
  };
}

export async function createRuntimeDeps(env: NodeJS.ProcessEnv = process.env): Promise<ProvisionerAppDeps> {
  const config = loadConfig(env);
  const firestore = getFirestore({ signer: 'kms', vertex: 'fake', pubsub: 'gcp', store: env.STORE_MODE === 'gcp' ? 'gcp' : 'emulator' }, env);
  const documents = createFirestoreDocumentStore(firestore, 'provisioner');
  const admin = createGcpAdmin(env);
  const identityToken = createIdentityTokenProvider();

  const agentOp = createAgentOpClient({ baseUrl: config.sharedAgentOpUrl, identityToken });

  return {
    config,
    documents,
    // Abandoning a transaction gives back the connection it had asked for, so the
    // store is handed the same client the provisioning steps use (T-PROV-13).
    transactions: createTransactionStore(documents, () => Date.now(), {
      revokeIdpConnection: (idpConnectionId) => agentOp.revokeIdpConnection!(idpConnectionId),
    }),
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
    // The shared publisher validates against the canonical schema before it sends. A
    // raw topic write here would put events on the stream the subscriber then drops.
    publishActivity: publishActivityEvent,
    agentOp,
    createDedicated: (input) => createDedicatedResources({
      admin,
      ledger: input.ledger,
      agentId: input.agentId,
      projectId: required(env, 'PROJECT_ID'),
      region: required(env, 'REGION'),
      signingKeyRing: required(env, 'IDJAG_KEY_RING'),
      connectionKeyRing: required(env, 'IDP_CONNECTION_KEY_RING'),
      imageEnv: JSON.parse(env.DEDICATED_OP_ENV ?? '{}') as Record<string, string>,
      runtimeEnv: JSON.parse(env.DEDICATED_RUNTIME_ENV ?? '{}') as Record<string, string>,
      jwksBucket: required(env, 'JWKS_BUCKET'),
      activityTopic: config.activityTopic,
      runtimeInvokerServices: JSON.parse(required(env, 'DEDICATED_RUNTIME_INVOKER_SERVICES')) as string[],
      provisionerMember: `serviceAccount:${required(env, 'PROVISIONER_SA_EMAIL')}`,
      agentPlatformClientSecret: required(env, 'AGENT_PLATFORM_CLIENT_SECRET_ID'),
      taskTimeoutSeconds: input.taskTimeoutSeconds,
    }),
  };
}

/**
 * The GCP admin calls. Every mutating method re-checks its own name with
 * assertRuntimeName, so the boundary holds at the call site as well as at the caller in
 * dedicated.ts: no name outside the six runtime prefixes can reach a GCP API from here.
 */
function createGcpAdmin(env: NodeJS.ProcessEnv): GcpAdmin {
  const project = env.PROJECT_ID ?? '';
  const region = env.REGION ?? '';
  const kms = new KeyManagementServiceClient();
  const services = new ServicesClient();
  const jobs = new JobsClient();
  const pubsub = new PubSub();
  const storage = new Storage();
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const identityToken = createIdentityTokenProvider(auth);
  return {
    async createServiceAccount(input) {
      assertRuntimeName(input.accountId);
      const response = await auth.request<{ name?: string; email?: string }>({
        url: `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`,
        method: 'POST',
        data: { accountId: input.accountId, serviceAccount: { description: input.description } },
      });
      const email = response.data.email ?? `${input.accountId}@${project}.iam.gserviceaccount.com`;
      return {
        name: response.data.name ?? `projects/${project}/serviceAccounts/${email}`,
        email,
        member: `serviceAccount:${email}`,
      };
    },
    async createCryptoKey(input) {
      assertRuntimeName(input.keyId);
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
    async bindRole(input) {
      await addIamBinding({ ...input, kms, services, pubsub, storage, auth });
      return `${input.resource}|${input.role}|${input.member}`;
    },
    async createService(input) {
      assertRuntimeName(input.name);
      const [operation] = await services.createService({
        parent: `projects/${project}/locations/${region}`,
        serviceId: input.name,
        service: {
          labels: input.labels,
          // Its one caller is the agent's own Cloud Run Job, and a Cloud Run call leaves
          // through the internet in a project with no VPC: internal-only ingress answers
          // it 404 at the front end before `roles/run.invoker` is ever read
          // (infra/spike/RESULT.md, DEC-IAC-14). Who may call is unchanged — only
          // `sa-agent-<short>` holds the invoker role on this service — and an
          // unauthenticated request is refused at the door with 403.
          ingress: 'INGRESS_TRAFFIC_ALL',
          template: {
            serviceAccount: input.serviceAccount.replace(/^serviceAccount:/, ''),
              containers: [{ image: env.AGENT_OP_IMAGE ?? '', env: serviceEnvironment(input.env) }],
          },
        },
      });
      let service = await operation.promise().then(([value]) => value);
      if (!input.env.PUBLIC_BASE_URL && service.uri) {
        const containers = service.template?.containers ?? [];
        if (containers[0]) containers[0].env = serviceEnvironment({ ...input.env, PUBLIC_BASE_URL: service.uri });
        const [update] = await services.updateService({
          service,
          updateMask: { paths: ['template.containers'] },
        });
        service = await update.promise().then(([value]) => value);
      }
      return { name: service.name ?? '', uri: service.uri ?? '' };
    },
    async createJob(input) {
      assertRuntimeName(input.name);
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
              containers: [{
                image: env.AGENT_RUNTIME_IMAGE ?? '',
                env: Object.entries(input.env).map(([name, value]) => ({ name, value })),
              }],
            },
          },
        },
      });
      const job = await operation.promise().then(([value]) => value);
      return job.name ?? '';
    },
    async healthCheck(uri) {
      try {
        const token = await identityToken(new URL(uri).origin);
        return (await fetch(`${uri}/healthz`, { headers: { Authorization: `Bearer ${token}` } })).ok;
      } catch { return false; }
    },
  };
}

export { verifyGoogleServiceIdentity };

function serviceEnvironment(values: Record<string, string>) {
  const secret = values.CLIENT_SECRET_AGENT_PLATFORM_SECRET;
  return [
    ...Object.entries(values)
      .filter(([name]) => name !== 'CLIENT_SECRET_AGENT_PLATFORM_SECRET')
      .map(([name, value]) => ({ name, value })),
    ...(secret ? [{
      name: 'CLIENT_SECRET_AGENT_PLATFORM',
      valueSource: { secretKeyRef: { secret, version: 'latest' } },
    }] : []),
  ];
}

interface IamBinding { role?: string | null; members?: string[] | null }
interface IamPolicy { bindings?: IamBinding[] | null; etag?: string | Uint8Array | null; version?: number | null }

function addMember(policy: IamPolicy, role: string, member: string): boolean {
  const bindings = policy.bindings ?? [];
  const binding = bindings.find((candidate) => candidate.role === role);
  if (binding) {
    const members = binding.members ?? [];
    if (members.includes(member)) return false;
    binding.members = [...members, member];
  } else {
    bindings.push({ role, members: [member] });
  }
  policy.bindings = bindings;
  policy.version = Math.max(policy.version ?? 1, 3);
  return true;
}

async function addIamBinding(input: {
  resource: string;
  role: string;
  member: string;
  kms: KeyManagementServiceClient;
  services: ServicesClient;
  pubsub: PubSub;
  storage: Storage;
  auth: GoogleAuth;
}): Promise<void> {
  if (/\/keyRings\/[^/]+\/cryptoKeys\//.test(input.resource)) {
    const [policy] = await input.kms.getIamPolicy(
      { resource: input.resource, options: { requestedPolicyVersion: 3 } } as never,
    );
    if (addMember(policy as IamPolicy, input.role, input.member)) {
      await input.kms.setIamPolicy({ resource: input.resource, policy } as never);
    }
    return;
  }
  if (/\/locations\/[^/]+\/services\//.test(input.resource)) {
    const [policy] = await input.services.getIamPolicy(
      { resource: input.resource, options: { requestedPolicyVersion: 3 } } as never,
    );
    if (addMember(policy as IamPolicy, input.role, input.member)) {
      await input.services.setIamPolicy({ resource: input.resource, policy } as never);
    }
    return;
  }
  if (input.resource.startsWith('projects/_/buckets/')) {
    const bucket = input.storage.bucket(input.resource.slice('projects/_/buckets/'.length));
    const [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
    if (addMember(policy as IamPolicy, input.role, input.member)) await bucket.iam.setPolicy(policy);
    return;
  }
  if (/^projects\/[^/]+\/topics\//.test(input.resource)) {
    const topic = input.pubsub.topic(input.resource);
    const [policy] = await topic.iam.getPolicy();
    if (addMember(policy as IamPolicy, input.role, input.member)) await topic.iam.setPolicy(policy);
    return;
  }
  if (/^projects\/[^/]+\/secrets\//.test(input.resource)) {
    const endpoint = `https://secretmanager.googleapis.com/v1/${input.resource}`;
    const response = await input.auth.request<IamPolicy>({ url: `${endpoint}:getIamPolicy`, method: 'GET' });
    if (addMember(response.data, input.role, input.member)) {
      await input.auth.request({ url: `${endpoint}:setIamPolicy`, method: 'POST', data: { policy: response.data } });
    }
    return;
  }
  if (/^projects\/[^/]+$/.test(input.resource)) {
    const endpoint = `https://cloudresourcemanager.googleapis.com/v1/${input.resource}`;
    const response = await input.auth.request<IamPolicy>({
      url: `${endpoint}:getIamPolicy`, method: 'POST', data: { options: { requestedPolicyVersion: 3 } },
    });
    if (addMember(response.data, input.role, input.member)) {
      await input.auth.request({ url: `${endpoint}:setIamPolicy`, method: 'POST', data: { policy: response.data } });
    }
    return;
  }
  throw new Error(`unsupported IAM binding resource: ${input.resource}`);
}
