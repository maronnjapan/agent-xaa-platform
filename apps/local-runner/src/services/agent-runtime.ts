import { runAgent } from '@xaa/agent-runtime/src/run';
import type { InvokerIdToken } from '@xaa/agent-runtime/src/http/internal-invoker-token';
import { createFirestoreDocumentStore } from '@xaa/gcp';
import type { RunningExecution } from '../local/cloud-run.js';
import { TOPICS, type LocalPlatform } from '../platform.js';

/**
 * The environment on the Agent Runtime Job definition — everything that is the same for
 * every agent (`infra/envs/demo/jobs.tf`).
 *
 * The eleven per-agent values are not here and must not be: they arrive as an Execution
 * override, so the shared Job definition never contains any agent's data.
 */
export function agentRuntimeStaticEnvironment(platform: LocalPlatform, isolation: 'standard' | 'full_isolation'): Record<string, string> {
  return {
    APP_NAME: 'agent-runtime',
    PROJECT_ID: platform.config.topology.projectId,
    GOOGLE_CLOUD_PROJECT: platform.config.topology.projectId,
    REGION: platform.config.topology.region,
    ISOLATION_LEVEL: isolation,
    AGENT_MAX_LIFETIME_SECONDS: String(platform.config.topology.agentMaxLifetimeSeconds),
    ACTIVITY_TOPIC: TOPICS.activity,
    LOG_LEVEL: 'info',
    STORE_MODE: 'emulator',
    PUBSUB_MODE: 'inproc',
    SIGNER_MODE: 'local',
    VERTEX_MODE: 'fake',
    VERTEX_MODEL: platform.config.topology.vertexModel,
    VERTEX_LOCATION: platform.config.topology.vertexLocation,
  };
}

/**
 * One Agent Runtime Execution.
 *
 * An Execution is a process on GCP, and the closest honest thing here is an async call
 * that owns its own environment map: `runAgent` reads the eleven overrides from what it
 * is handed rather than from `process.env`, so two agents running at once cannot see
 * each other's credentials through a shared global — which is the property the separate
 * container gave for free and the one worth keeping.
 *
 * It gets no Cloud Run invoker token, exactly as it gets none when `STORE_MODE` is not
 * `gcp`: there is no metadata server here, and the destinations it calls are on this
 * machine.
 */
export function startAgentRuntimeExecution(platform: LocalPlatform, input: { jobName: string; env: Record<string, string> }): RunningExecution {
  const controller = new AbortController();
  const documents = createFirestoreDocumentStore(platform.firestore, 'agent-runtime');
  const cancelled = new Promise<number>((resolve) => {
    controller.signal.addEventListener('abort', () => { resolve(RUNTIME_CANCELLED); });
  });
  const finished = (async (): Promise<number> => {
    try {
      await Promise.race([sleep(platform.config.executionStartDelayMs), cancelled]);
      if (controller.signal.aborted) return RUNTIME_CANCELLED;
      return await Promise.race([runAgent({ env: input.env, documents, invokerToken: noInvokerToken }), cancelled]);
    } catch (error) {
      process.stderr.write(`[local] ${input.jobName} execution failed: ${(error as Error).message}\n`);
      return RUNTIME_CANCELLED;
    }
  })();
  return { finished, cancel: () => { controller.abort(); } };
}

/**
 * The wait before the agent's first reasoning step.
 *
 * Cloud Run takes seconds to schedule an Execution and pull its image, and the platform
 * leans on that: the Provisioner starts the Job, answers, and the Automation App then
 * writes the agent's first instruction — the work it is meant to do. Starting instantly,
 * as an in-process call otherwise would, loses that race, and the agent reasons once
 * about an empty conversation and reports itself finished.
 *
 * Being faster than production is not fidelity. The pause is what makes the local
 * platform behave the way the deployed one does, and `LOCAL_EXECUTION_START_DELAY_MS`
 * is there for anyone who wants to watch it lose the race on purpose.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

/**
 * What a cancelled Execution reports. Cloud Run gives a cancelled Execution no exit
 * code at all, and the Lifecycle Manager reads the cancellation rather than a code, so
 * the value only has to be distinct from the four `RUNTIME_EXIT_CODES`.
 */
const RUNTIME_CANCELLED = -1;

const noInvokerToken = async (): Promise<InvokerIdToken | undefined> => undefined;
