import { DEDICATED_AGENT_SA_ROLES, DEDICATED_OP_SA_ROLES } from '@xaa/contracts';
import { assertRuntimeName, dedicatedNames, runtimeDescription, runtimeLabels } from '@xaa/contracts';
import type { createDedicatedLedger } from './dedicated-ledger.js';

/**
 * The GCP admin surface this module needs, as an interface rather than the SDK, so a
 * STANDARD provisioning can be shown to call none of it.
 */
export interface GcpAdmin {
  createServiceAccount(input: { accountId: string; description: string }): Promise<{
    name: string;
    email: string;
    member: string;
  }>;
  createCryptoKey(input: { keyRing: string; keyId: string; purpose: 'EC_SIGN_P256_SHA256' | 'ENCRYPT_DECRYPT'; labels: Record<string, string> }): Promise<string>;
  bindRole(input: { resource: string; member: string; role: string }): Promise<string>;
  createService(input: { name: string; serviceAccount: string; env: Record<string, string>; labels: Record<string, string> }): Promise<{ name: string; uri: string }>;
  createJob(input: {
    name: string;
    serviceAccount: string;
    taskTimeoutSeconds: number;
    env: Record<string, string>;
    labels: Record<string, string>;
  }): Promise<string>;
  healthCheck(uri: string): Promise<boolean>;
}

export interface DedicatedResult {
  opServiceUri: string;
  signingKeyName: string;
  connectionKeyName: string;
  runtimeJobName: string;
  agentServiceAccount: string;
}

const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 5_000;

export class DedicatedProvisioningTimeout extends Error {
  constructor() { super('dedicated_provisioning_timeout'); }
}

/**
 * DEC-IAC-07. A FULL_ISOLATION agent gets its own OP, its own signing key, its own
 * encryption key, its own two service accounts and its own runtime job.
 *
 * None of it is in Terraform, because all of it disappears within a day: the
 * reproducibility Terraform buys is worth nothing for a resource with that lifetime,
 * and pre-creating a fixed pool would both cap concurrency and leave idle resources
 * standing. What Terraform does own is the key rings these keys go into and the
 * permission to create them.
 *
 * Order matters: identities first, then keys, then the bindings between them, then
 * the workloads that use them. Every step is appended to the ledger as it completes,
 * so a failure halfway leaves an accurate record to clean up from.
 *
 * IAM propagation is not instant, so the new OP is polled until it answers rather
 * than assumed ready — an agent whose OP cannot yet sign would fail its first
 * exchange for no visible reason.
 */
export async function createDedicatedResources(options: {
  admin: GcpAdmin;
  ledger: ReturnType<typeof createDedicatedLedger>;
  agentId: string;
  projectId: string;
  region: string;
  signingKeyRing: string;
  connectionKeyRing: string;
  imageEnv: Record<string, string>;
  runtimeEnv: Record<string, string>;
  jwksBucket: string;
  activityTopic: string;
  runtimeInvokerServices: readonly string[];
  provisionerMember: string;
  agentPlatformClientSecret: string;
  taskTimeoutSeconds: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DedicatedResult> {
  const names = dedicatedNames(options.agentId);
  const labels = runtimeLabels(options.agentId);
  const description = runtimeDescription(options.agentId);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }));

  // (1) and (2): the two identities.
  const opServiceAccount = await options.admin.createServiceAccount({ accountId: assertRuntimeName(names.opServiceAccount), description });
  await options.ledger.record(options.agentId, 'service_account', opServiceAccount.name);
  const agentServiceAccount = await options.admin.createServiceAccount({ accountId: assertRuntimeName(names.agentServiceAccount), description });
  await options.ledger.record(options.agentId, 'service_account', agentServiceAccount.name);

  // (3) and (4): the two keys, in the key rings Terraform provides.
  const signingKeyName = await options.admin.createCryptoKey({
    keyRing: options.signingKeyRing, keyId: assertRuntimeName(names.signingKey), purpose: 'EC_SIGN_P256_SHA256', labels,
  });
  await options.ledger.record(options.agentId, 'crypto_key', signingKeyName);
  const connectionKeyName = await options.admin.createCryptoKey({
    keyRing: options.connectionKeyRing, keyId: assertRuntimeName(names.connectionKey), purpose: 'ENCRYPT_DECRYPT', labels,
  });
  await options.ledger.record(options.agentId, 'crypto_key', connectionKeyName);

  // (5): the bindings. The role names come from the shared constant table, so the
  // Terraform-side check and this code cannot disagree about what is granted.
  const projectResource = `projects/${options.projectId}`;
  const activityTopicResource = `${projectResource}/topics/${options.activityTopic}`;
  const opTargets = [
    [signingKeyName, roleEnding(DEDICATED_OP_SA_ROLES, '/cloudkms.signerVerifier')],
    [connectionKeyName, roleEnding(DEDICATED_OP_SA_ROLES, '/cloudkms.cryptoKeyEncrypterDecrypter')],
    [projectResource, roleEnding(DEDICATED_OP_SA_ROLES, '/datastore.user')],
    [`projects/_/buckets/${options.jwksBucket}`, roleEnding(DEDICATED_OP_SA_ROLES, '/storage.objectCreator')],
    [activityTopicResource, roleEnding(DEDICATED_OP_SA_ROLES, '/pubsub.publisher')],
    [options.agentPlatformClientSecret, roleEnding(DEDICATED_OP_SA_ROLES, '/secretmanager.secretAccessor')],
  ] as const;
  for (const [resource, role] of opTargets) {
    const binding = await options.admin.bindRole({ resource, member: opServiceAccount.member, role });
    await options.ledger.record(options.agentId, 'iam_binding', binding);
  }

  // (6): the dedicated OP.
  const service = await options.admin.createService({
    name: assertRuntimeName(names.opService),
    serviceAccount: opServiceAccount.email,
    env: {
      ...options.imageEnv,
      AGENT_ID: options.agentId,
      KMS_IDJAG_KEY: `${signingKeyName}/cryptoKeyVersions/1`,
      KMS_IDP_CONNECTION_KEY: connectionKeyName,
      CLIENT_SECRET_AGENT_PLATFORM_SECRET: options.agentPlatformClientSecret,
    },
    labels,
  });
  await options.ledger.record(options.agentId, 'cloud_run_service', service.name);

  const runInvoker = roleEnding(DEDICATED_AGENT_SA_ROLES, '/run.invoker');
  for (const member of [agentServiceAccount.member, options.provisionerMember]) {
    const binding = await options.admin.bindRole({ resource: service.name, member, role: runInvoker });
    await options.ledger.record(options.agentId, 'iam_binding', binding);
  }
  for (const resource of options.runtimeInvokerServices) {
    const binding = await options.admin.bindRole({ resource, member: agentServiceAccount.member, role: runInvoker });
    await options.ledger.record(options.agentId, 'iam_binding', binding);
  }
  for (const [resource, role] of [
    [projectResource, roleEnding(DEDICATED_AGENT_SA_ROLES, '/aiplatform.user')],
    [projectResource, roleEnding(DEDICATED_AGENT_SA_ROLES, '/datastore.user')],
    [activityTopicResource, roleEnding(DEDICATED_AGENT_SA_ROLES, '/pubsub.publisher')],
  ] as const) {
    const binding = await options.admin.bindRole({ resource, member: agentServiceAccount.member, role });
    await options.ledger.record(options.agentId, 'iam_binding', binding);
  }

  const deadline = now() + HEALTH_TIMEOUT_MS;
  while (!await options.admin.healthCheck(service.uri)) {
    if (now() >= deadline) throw new DedicatedProvisioningTimeout();
    await sleep(HEALTH_INTERVAL_MS);
  }

  // (7): the runtime job, timed out at the agent's remaining life.
  const jobName = await options.admin.createJob({
    name: assertRuntimeName(names.runtimeJob),
    serviceAccount: agentServiceAccount.email,
    taskTimeoutSeconds: options.taskTimeoutSeconds,
    env: { ...options.runtimeEnv, ISOLATION_LEVEL: 'full_isolation' },
    labels,
  });
  await options.ledger.record(options.agentId, 'cloud_run_job', jobName);

  return {
    opServiceUri: service.uri,
    signingKeyName,
    connectionKeyName,
    runtimeJobName: jobName,
    agentServiceAccount: agentServiceAccount.email,
  };
}

function roleEnding(roles: readonly string[], suffix: string): string {
  const role = roles.find((candidate) => candidate.endsWith(suffix));
  if (!role) throw new Error(`dedicated IAM contract is missing ${suffix}`);
  return role;
}
