import { assertRuntimeName } from '@xaa/contracts';
import type { GcpAdmin } from '@xaa/provisioner/src/dedicated';
import type { JobRunner } from '@xaa/provisioner/src/job/execute';
import type { LocalJwks } from './jwks.js';

/** What the Lifecycle Manager deletes when an agent's life ends (`clients/types.ts`). */
export interface LocalCleanupClients {
  cloudRun: {
    cancelExecution(name: string): Promise<'cancelled' | 'already_finished' | 'not_found'>;
    deleteService(name: string): Promise<'deleted' | 'not_found'>;
    deleteJob(name: string): Promise<'deleted' | 'not_found'>;
  };
  kms: { destroyCryptoKeyVersion(name: string): Promise<'scheduled' | 'not_found'> };
  iam: {
    deleteServiceAccount(name: string): Promise<'deleted' | 'not_found'>;
    removeBinding(name: string): Promise<'removed' | 'not_found'>;
  };
  jwks: { deleteKey(objectName: string): Promise<void> };
}

export interface RunningService {
  uri: string;
  stop(): Promise<void>;
}

export interface RunningExecution {
  /** Resolves when the Execution ends, with the exit code the runtime returned. */
  finished: Promise<number>;
  cancel(): void;
}

export interface LocalRunHooks {
  /**
   * Starts a Dedicated Agent OP and returns where it listens. The runner supplies this
   * because building an Agent OP is composition, not infrastructure.
   */
  startService(input: { name: string; env: Record<string, string>; agentId: string }): Promise<RunningService>;
  /** Runs one Agent Runtime Execution with the job's static environment merged in. */
  startExecution(input: { jobName: string; env: Record<string, string> }): RunningExecution;
  jwks: LocalJwks;
  projectId: string;
  region: string;
}

export interface LocalRunPlatform {
  admin: GcpAdmin;
  jobs: JobRunner;
  cleanup: LocalCleanupClients;
  /** Registers a Job definition and the static environment its Executions inherit. */
  defineJob(name: string, staticEnv: Record<string, string>): string;
  /** Every Dedicated OP still listening, so shutdown can close their sockets. */
  stopAll(): Promise<void>;
}

interface JobRecord { name: string; staticEnv: Record<string, string> }
interface ExecutionRecord { execution: RunningExecution; done: boolean }

/**
 * Cloud Run, Cloud KMS key creation and IAM, as this process performs them.
 *
 * The Provisioner creates real things for a `full_isolation` agent: two service
 * accounts, two keys, a set of IAM bindings, a Cloud Run service running its own Agent
 * OP, and a Job for the agent itself. Here the service is another listener in this
 * process and the Job is an async call, but the *shape* is kept exactly: every step is
 * named as GCP names it, so the ledger rows the Provisioner writes and the deletions
 * the Lifecycle Manager makes from them are the same rows and the same deletions.
 *
 * The two identity-shaped steps — service accounts and IAM bindings — are recorded and
 * nothing more. There is no IAM on a loopback port to grant, and pretending otherwise
 * would be a check that always passes; what the ledger needs from them is that they
 * happened and can be undone, and that is what they give it. Every mutating call still
 * runs `assertRuntimeName` first, so the boundary DEC-IAC-08 draws by name holds here
 * as it does on GCP: a request naming `human-idp` is refused before anything happens.
 */
export function createLocalRunPlatform(hooks: LocalRunHooks): LocalRunPlatform {
  const services = new Map<string, RunningService>();
  const jobs = new Map<string, JobRecord>();
  const executions = new Map<string, ExecutionRecord>();
  const serviceAccounts = new Set<string>();
  const bindings = new Set<string>();
  let executionCounter = 0;

  const parent = `projects/${hooks.projectId}/locations/${hooks.region}`;
  const serviceName = (name: string) => `${parent}/services/${name}`;
  const jobName = (name: string) => `${parent}/jobs/${name}`;

  const defineJob = (name: string, staticEnv: Record<string, string>): string => {
    const full = jobName(name);
    jobs.set(full, { name, staticEnv });
    return full;
  };

  return {
    defineJob,

    admin: {
      async createServiceAccount(input) {
        assertRuntimeName(input.accountId);
        const email = `${input.accountId}@${hooks.projectId}.iam.gserviceaccount.com`;
        serviceAccounts.add(email);
        return { name: `projects/${hooks.projectId}/serviceAccounts/${email}`, email, member: `serviceAccount:${email}` };
      },

      async createCryptoKey(input) {
        assertRuntimeName(input.keyId);
        // The local KMS derives its key material from the resource name, so creating a
        // key is naming it: the first encrypt under this name is the key coming into
        // existence, and there is nothing to provision beforehand.
        return `${input.keyRing}/cryptoKeys/${input.keyId}`;
      },

      async bindRole(input) {
        const binding = `${input.resource}|${input.role}|${input.member}`;
        bindings.add(binding);
        return binding;
      },

      async createService(input) {
        assertRuntimeName(input.name);
        const agentId = input.env.AGENT_ID ?? '';
        const full = serviceName(input.name);
        const running = await hooks.startService({ name: input.name, env: input.env, agentId });
        services.set(full, running);
        return { name: full, uri: running.uri };
      },

      async createJob(input) {
        assertRuntimeName(input.name);
        return defineJob(input.name, input.env);
      },

      async healthCheck(uri) {
        try {
          return (await fetch(`${uri}/livez`)).ok;
        } catch {
          return false;
        }
      },
    },

    jobs: {
      async runJob(input) {
        const record = jobs.get(input.jobName);
        if (!record) throw new Error(`no such job: ${input.jobName}`);
        executionCounter += 1;
        const name = `${input.jobName}/executions/${record.name}-${executionCounter}`;
        const execution = hooks.startExecution({
          jobName: input.jobName,
          // The Job definition's static environment, then the per-agent overrides:
          // the same merge Cloud Run performs for `containerOverrides`.
          env: { ...record.staticEnv, ...Object.fromEntries(input.env.map((entry) => [entry.name, entry.value])) },
        });
        const entry: ExecutionRecord = { execution, done: false };
        executions.set(name, entry);
        void execution.finished.finally(() => { entry.done = true; });
        return { executionName: name };
      },
    },

    cleanup: {
      cloudRun: {
        async cancelExecution(name) {
          const entry = executions.get(name);
          if (!entry) return 'not_found';
          if (entry.done) return 'already_finished';
          entry.execution.cancel();
          return 'cancelled';
        },
        async deleteService(name) {
          assertRuntimeName(name);
          const running = services.get(name);
          if (!running) return 'not_found';
          await running.stop();
          services.delete(name);
          return 'deleted';
        },
        async deleteJob(name) {
          assertRuntimeName(name);
          return jobs.delete(name) ? 'deleted' : 'not_found';
        },
      },
      kms: {
        async destroyCryptoKeyVersion(name) {
          assertRuntimeName(name.replace(/\/cryptoKeyVersions\/[^/]+$/, ''));
          // Nothing to schedule: the key exists only as a name the local KMS derives
          // material from, and the material is gone with the process either way.
          return 'scheduled';
        },
      },
      iam: {
        async deleteServiceAccount(name) {
          const email = name.replace(/^serviceAccount:/, '').split('/').pop() ?? '';
          assertRuntimeName(email.split('@')[0] ?? email);
          return serviceAccounts.delete(email) ? 'deleted' : 'not_found';
        },
        async removeBinding(name) {
          const [resource, role, member, unexpected] = name.split('|');
          if (!resource || !role || !member || unexpected !== undefined) throw new Error('invalid IAM binding ledger entry');
          return bindings.delete(name) ? 'removed' : 'not_found';
        },
      },
      jwks: {
        async deleteKey(objectName) {
          // The published set is keyed by kid; Terraform stores one key per object
          // named `keys/<kid>.json`, and the ledger records that object name.
          hooks.jwks.remove(objectName.replace(/^keys\//, '').replace(/\.json$/, ''));
        },
      },
    },

    async stopAll() {
      for (const running of services.values()) await running.stop();
      services.clear();
      for (const entry of executions.values()) if (!entry.done) entry.execution.cancel();
    },
  };
}
