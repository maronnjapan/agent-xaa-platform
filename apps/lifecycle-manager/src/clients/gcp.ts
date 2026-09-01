import { KeyManagementServiceClient } from '@google-cloud/kms';
import { PubSub } from '@google-cloud/pubsub';
import { ExecutionsClient, JobsClient, ServicesClient } from '@google-cloud/run';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { assertRuntimeName } from '@xaa/contracts';
import type { CleanupClients } from './types.js';

interface PolicyBinding { role?: string | null; members?: string[] | null }
interface Policy { bindings?: PolicyBinding[] | null; etag?: string | Uint8Array | null; version?: number | null }
interface ApiError { code?: number; response?: { status?: number } }

const isCode = (error: unknown, ...codes: number[]) => {
  const candidate = error as ApiError;
  return codes.includes(candidate.code ?? -1) || codes.includes(candidate.response?.status ?? -1);
};

function removeMember(policy: Policy, role: string, member: string): boolean {
  let removed = false;
  policy.bindings = (policy.bindings ?? []).flatMap((binding) => {
    if (binding.role !== role) return [binding];
    const members = (binding.members ?? []).filter((candidate) => {
      if (candidate !== member) return true;
      removed = true;
      return false;
    });
    return members.length === 0 ? [] : [{ ...binding, members }];
  });
  return removed;
}

/**
 * Production implementations for the runtime resources recorded by Provisioner.
 *
 * Every deleting method re-checks its own name with assertRuntimeName. The cleanup step
 * that calls it already does, but the boundary in DEC-IAC-08 is worth holding twice: a
 * ledger row naming a Terraform-managed service raises here rather than deleting it.
 */
export function createLifecycleGcpClients(input: {
  jwksBucket: string;
  executions?: ExecutionsClient;
  jobs?: JobsClient;
  services?: ServicesClient;
  kms?: KeyManagementServiceClient;
  pubsub?: PubSub;
  storage?: Storage;
  auth?: GoogleAuth;
}): Pick<CleanupClients, 'cloudRun' | 'kms' | 'iam' | 'jwks'> {
  const executions = input.executions ?? new ExecutionsClient();
  const jobs = input.jobs ?? new JobsClient();
  const services = input.services ?? new ServicesClient();
  const kms = input.kms ?? new KeyManagementServiceClient();
  const pubsub = input.pubsub ?? new PubSub();
  const storage = input.storage ?? new Storage();
  const auth = input.auth ?? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

  return {
    cloudRun: {
      async cancelExecution(name) {
        try {
          const [execution] = await executions.getExecution({ name });
          if (execution.completionTime || Number(execution.cancelledCount ?? 0) > 0) return 'already_finished';
          const [operation] = await executions.cancelExecution({ name });
          await operation.promise();
          return 'cancelled';
        } catch (error) {
          if (isCode(error, 5, 404)) return 'not_found';
          if (isCode(error, 9, 400)) return 'already_finished';
          throw error;
        }
      },
      async deleteService(name) {
        assertRuntimeName(name);
        try {
          const [operation] = await services.deleteService({ name });
          await operation.promise();
          return 'deleted';
        } catch (error) {
          if (isCode(error, 5, 404)) return 'not_found';
          throw error;
        }
      },
      async deleteJob(name) {
        assertRuntimeName(name);
        try {
          const [operation] = await jobs.deleteJob({ name });
          await operation.promise();
          return 'deleted';
        } catch (error) {
          if (isCode(error, 5, 404)) return 'not_found';
          throw error;
        }
      },
    },
    kms: {
      async destroyCryptoKeyVersion(name) {
        // The version number is the leaf here, so the key that owns it is what the
        // runtime namespace guard has to look at.
        assertRuntimeName(name.replace(/\/cryptoKeyVersions\/[^/]+$/, ''));
        try {
          await kms.destroyCryptoKeyVersion({ name });
          return 'scheduled';
        } catch (error) {
          if (isCode(error, 5, 404)) return 'not_found';
          // Destroy is idempotent for a version whose destruction is already pending.
          if (isCode(error, 9, 400)) return 'scheduled';
          throw error;
        }
      },
    },
    iam: {
      async deleteServiceAccount(name) {
        const email = name.replace(/^serviceAccount:/, '');
        assertRuntimeName(email.split('@')[0]!);
        try {
          await auth.request({
            url: `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}`,
            method: 'DELETE',
          });
          return 'deleted';
        } catch (error) {
          if (isCode(error, 5, 404)) return 'not_found';
          throw error;
        }
      },
      async removeBinding(name) {
        const [resource, role, member, unexpected] = name.split('|');
        if (!resource || !role || !member || unexpected !== undefined) throw new Error('invalid IAM binding ledger entry');
        try {
          return await removeIamBinding({ resource, role, member, kms, services, pubsub, storage, auth });
        } catch (error) {
          if (isCode(error, 5, 404)) return 'not_found';
          throw error;
        }
      },
    },
    jwks: {
      async deleteKey(objectName) {
        await storage.bucket(input.jwksBucket).file(objectName).delete({ ignoreNotFound: true });
      },
    },
  };
}

async function removeIamBinding(input: {
  resource: string;
  role: string;
  member: string;
  kms: KeyManagementServiceClient;
  services: ServicesClient;
  pubsub: PubSub;
  storage: Storage;
  auth: GoogleAuth;
}): Promise<'removed' | 'not_found'> {
  if (/\/keyRings\/[^/]+\/cryptoKeys\//.test(input.resource)) {
    const [policy] = await input.kms.getIamPolicy(
      { resource: input.resource, options: { requestedPolicyVersion: 3 } } as never,
    );
    if (!removeMember(policy as Policy, input.role, input.member)) return 'not_found';
    await input.kms.setIamPolicy({ resource: input.resource, policy } as never);
    return 'removed';
  }
  if (/\/locations\/[^/]+\/services\//.test(input.resource)) {
    const [policy] = await input.services.getIamPolicy(
      { resource: input.resource, options: { requestedPolicyVersion: 3 } } as never,
    );
    if (!removeMember(policy as Policy, input.role, input.member)) return 'not_found';
    await input.services.setIamPolicy({ resource: input.resource, policy } as never);
    return 'removed';
  }
  if (input.resource.startsWith('projects/_/buckets/')) {
    const bucketName = input.resource.slice('projects/_/buckets/'.length);
    const [policy] = await input.storage.bucket(bucketName).iam.getPolicy({ requestedPolicyVersion: 3 });
    if (!removeMember(policy as Policy, input.role, input.member)) return 'not_found';
    await input.storage.bucket(bucketName).iam.setPolicy(policy);
    return 'removed';
  }
  if (/^projects\/[^/]+\/topics\//.test(input.resource)) {
    const topic = input.pubsub.topic(input.resource);
    const [policy] = await topic.iam.getPolicy();
    if (!removeMember(policy as Policy, input.role, input.member)) return 'not_found';
    await topic.iam.setPolicy(policy);
    return 'removed';
  }
  if (/^projects\/[^/]+\/secrets\//.test(input.resource)) {
    const endpoint = `https://secretmanager.googleapis.com/v1/${input.resource}`;
    const current = await input.auth.request<Policy>({ url: `${endpoint}:getIamPolicy`, method: 'GET' });
    if (!removeMember(current.data, input.role, input.member)) return 'not_found';
    await input.auth.request({ url: `${endpoint}:setIamPolicy`, method: 'POST', data: { policy: current.data } });
    return 'removed';
  }
  if (/^projects\/[^/]+$/.test(input.resource)) {
    return mutateRestPolicy(input, `https://cloudresourcemanager.googleapis.com/v1/${input.resource}`);
  }
  throw new Error(`unsupported IAM binding resource: ${input.resource}`);
}

async function mutateRestPolicy(input: {
  resource: string;
  role: string;
  member: string;
  auth: GoogleAuth;
}, endpoint: string): Promise<'removed' | 'not_found'> {
  const current = await input.auth.request<Policy>({
    url: `${endpoint}:getIamPolicy`, method: 'POST', data: { options: { requestedPolicyVersion: 3 } },
  });
  const policy = current.data;
  if (!removeMember(policy, input.role, input.member)) return 'not_found';
  await input.auth.request({ url: `${endpoint}:setIamPolicy`, method: 'POST', data: { policy } });
  return 'removed';
}
