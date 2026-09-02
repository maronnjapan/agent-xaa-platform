import { assertRuntimeEnv, RUNTIME_ENV_KEYS, type RuntimeEnvOverrides } from '@xaa/contracts';
import { sha256Hex } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';
import { setJobExecutionName } from '../agent/registration.js';

export interface JobRunner {
  runJob(input: { jobName: string; env: Array<{ name: string; value: string }> }): Promise<{ executionName: string }>;
}

export class ExecutionAlreadyRunning extends Error {
  constructor(readonly agentId: string) { super('execution_already_running'); }
}

/**
 * RULE-04. An agent is a job execution, not a service: it starts, does its work and
 * ends, and its lifetime is bounded by the job's task timeout.
 *
 * Only the eleven per-agent values are overridden. Everything shared — the topic, the
 * project, the log level — is on the job definition in Terraform, so the shared
 * STANDARD job's definition contains no agent's data.
 */
export async function startAgentExecution(options: {
  runner: JobRunner;
  documents: DocumentStore;
  agentId: string;
  jobName: string;
  overrides: Omit<RuntimeEnvOverrides, 'TOOL_MANIFEST_SHA256'> & { TOOL_MANIFEST: string };
}): Promise<string> {
  const existing = await options.documents.get<{ job_execution_name?: string | null }>('agents', `${options.agentId}__meta`);
  // One execution per agent: a second would authenticate as the same identity and
  // race the first for the same state.
  if (existing?.job_execution_name) throw new ExecutionAlreadyRunning(options.agentId);

  const env: Record<string, string> = {
    ...options.overrides,
    // The digest lets the Runtime confirm the manifest reached it unmodified. Hex,
    // because that is what the Runtime's own check computes and compares against
    // (`apps/agent-runtime/src/manifest/load.ts`): the same bytes in another encoding
    // is a mismatch, and the Runtime refuses to start rather than run unverified.
    TOOL_MANIFEST_SHA256: await sha256Hex(options.overrides.TOOL_MANIFEST),
  };
  assertRuntimeEnv(env);

  const { executionName } = await options.runner.runJob({
    jobName: options.jobName,
    env: RUNTIME_ENV_KEYS.map((name) => ({ name, value: env[name] })),
  });
  await setJobExecutionName(options.documents, options.agentId, executionName);
  return executionName;
}
