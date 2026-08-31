import { DEDICATED_AGENT_SA_ROLES, DEDICATED_OP_SA_ROLES } from '@xaa/contracts';
import { assertRuntimeName, dedicatedNames, runtimeDescription, runtimeLabels } from '@xaa/contracts';
import type { createDedicatedLedger } from './dedicated-ledger.js';

/**
 * The GCP admin surface this module needs, as an interface rather than the SDK, so a
 * STANDARD provisioning can be shown to call none of it.
 */
export interface GcpAdmin {
  createServiceAccount(input: { accountId: string; description: string }): Promise<string>;
  createCryptoKey(input: { keyRing: string; keyId: string; purpose: 'EC_SIGN_P256_SHA256' | 'ENCRYPT_DECRYPT'; labels: Record<string, string> }): Promise<string>;
  bindRole(input: { resource: string; member: string; role: string }): Promise<string>;
  createService(input: { name: string; serviceAccount: string; env: Record<string, string>; labels: Record<string, string> }): Promise<{ name: string; uri: string }>;
  createJob(input: { name: string; serviceAccount: string; taskTimeoutSeconds: number; labels: Record<string, string> }): Promise<string>;
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
  await options.ledger.record(options.agentId, 'service_account', opServiceAccount);
  const agentServiceAccount = await options.admin.createServiceAccount({ accountId: assertRuntimeName(names.agentServiceAccount), description });
  await options.ledger.record(options.agentId, 'service_account', agentServiceAccount);

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
  for (const role of DEDICATED_OP_SA_ROLES) {
    const binding = await options.admin.bindRole({ resource: signingKeyName, member: opServiceAccount, role });
    await options.ledger.record(options.agentId, 'iam_binding', binding);
  }
  for (const role of new Set(DEDICATED_AGENT_SA_ROLES)) {
    const binding = await options.admin.bindRole({ resource: agentServiceAccount, member: agentServiceAccount, role });
    await options.ledger.record(options.agentId, 'iam_binding', binding);
  }

  // (6): the dedicated OP.
  const service = await options.admin.createService({
    name: assertRuntimeName(names.opService),
    serviceAccount: opServiceAccount,
    env: { ...options.imageEnv, AGENT_ID: options.agentId, KMS_IDJAG_KEY: signingKeyName, KMS_IDP_CONNECTION_KEY: connectionKeyName },
    labels,
  });
  await options.ledger.record(options.agentId, 'cloud_run_service', service.name);

  const deadline = now() + HEALTH_TIMEOUT_MS;
  while (!await options.admin.healthCheck(service.uri)) {
    if (now() >= deadline) throw new DedicatedProvisioningTimeout();
    await sleep(HEALTH_INTERVAL_MS);
  }

  // (7): the runtime job, timed out at the agent's remaining life.
  const jobName = await options.admin.createJob({
    name: assertRuntimeName(names.runtimeJob),
    serviceAccount: agentServiceAccount,
    taskTimeoutSeconds: options.taskTimeoutSeconds,
    labels,
  });
  await options.ledger.record(options.agentId, 'cloud_run_job', jobName);

  return {
    opServiceUri: service.uri,
    signingKeyName,
    connectionKeyName,
    runtimeJobName: jobName,
    agentServiceAccount,
  };
}
