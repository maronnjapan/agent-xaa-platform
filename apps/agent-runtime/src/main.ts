import { randomUUID } from 'node:crypto';
import { RUNTIME_EXIT_CODES, readModes } from '@xaa/contracts';
import { createFirestoreDocumentStore, getFirestore } from '@xaa/gcp';
import { createLogger, type LogContext } from '@xaa/logging';
import { createExecutionContext } from './context/execution-context.js';
import { loadEnv, ForbiddenEnvKey, MissingEnvKey } from './env.js';
import { buildAllowedHosts } from './http/allowed-hosts.js';
import { createRuntimeHttpClient } from './http/http-client.js';
import { createInvokerTokenProvider } from './http/internal-invoker-token.js';
import { manifestSha256 } from './manifest/load.js';
import { runReasoningLoop } from './reasoning/loop.js';
import { createRuntimeStore } from './store/runtime-store.js';
import { publishTaskOutcome } from './telemetry/activity.js';
import { createTerminalEmitter, decideTaskOutcome } from './telemetry/task-outcome.js';

/**
 * DEC-APP-02: the only app in the platform that is not an HTTP service.
 *
 * An Agent Runtime is one Cloud Run Job Execution running one agent. It listens on
 * nothing — there is no port, no route and no `serve()` anywhere in this package —
 * because an agent that accepted requests would be a place to send instructions that
 * bypassed the Automation App, and with it the record of who asked for what.
 *
 * The exit code is the Job's only channel back: 0 completed, 10 the agent's lifetime
 * ran out, 20 completed with something refused, 30 failed, 78 started with bad input.
 */
async function main(): Promise<number> {
  const logger = createLogger('agent-runtime', 'agent_runtime');
  let logContext: LogContext = { request_id: randomUUID(), trace_id: randomUUID(), agent_id: null, human_subject: null };

  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof ForbiddenEnvKey) {
      logger.critical('forbidden_env_key', logContext, { key: error.key });
      return RUNTIME_EXIT_CODES.invalidStartup;
    }
    if (error instanceof MissingEnvKey) {
      logger.critical('missing_env_key', logContext, { key: error.key });
      return RUNTIME_EXIT_CODES.invalidStartup;
    }
    throw error;
  }
  logContext = { ...logContext, agent_id: env.AGENT_ID, human_subject: env.HUMAN_SUBJECT };

  const manifestRaw = env.TOOL_MANIFEST;
  const store = createRuntimeStore({
    documents: createFirestoreDocumentStore(getFirestore(readModes(process.env)), 'agent-runtime'),
    agentId: env.AGENT_ID,
  });

  let context;
  try {
    context = await createExecutionContext({ env, store });
  } catch (error) {
    logger.critical('startup_failed', logContext, { message: (error as Error).message });
    return RUNTIME_EXIT_CODES.failed;
  }

  // The Agent OP and the Bridge sit behind Cloud Run's IAM check, so a call to either
  // needs this Execution's own `run.invoker` token beside the agent's credentials. On
  // GCP only: there is no metadata server anywhere else, and asking for one would turn
  // every local run into a timeout.
  const internalOrigins = new Set([
    new URL(env.AGENT_OP_BASE_URL).origin,
    ...context.manifest.tools
      .map((tool) => tool.token_provider)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => new URL(value).origin),
  ]);
  const http = createRuntimeHttpClient({
    allowedHosts: buildAllowedHosts(env, context.manifest),
    internalOrigins,
    invokerToken: createInvokerTokenProvider({ enabled: process.env.STORE_MODE === 'gcp' }),
  });
  const activityContext = {
    humanSubject: context.humanSubject, agentId: context.agentId, taskId: context.taskId,
    traceId: logContext.trace_id, manifest: context.manifest,
  };
  const terminal = createTerminalEmitter(async (outcome) => {
    await publishTaskOutcome({ context: activityContext, eventType: outcome, logger, ctx: logContext });
  });

  try {
    const loop = await runReasoningLoop({ context, http, logger, logContext });
    const outcome = loop.stoppedBy === 'reasoning_step_limit'
      ? 'TASK_FAILED'
      : decideTaskOutcome(loop.results);
    await terminal.emitTerminalOnce(outcome);

    // RULE-13 again, from the other end: the manifest that governed this execution is
    // the one it started with. A mismatch would mean something mutated it in memory.
    if (manifestSha256(manifestRaw) !== env.TOOL_MANIFEST_SHA256) {
      logger.critical('manifest_hash_changed', logContext, {});
      return RUNTIME_EXIT_CODES.failed;
    }
    logger.info('manifest_hash_stable', logContext, { sha256: env.TOOL_MANIFEST_SHA256 });

    if (loop.stoppedBy === 'agent_expired') return RUNTIME_EXIT_CODES.agentExpired;
    if (outcome === 'TASK_BLOCKED') return RUNTIME_EXIT_CODES.completedWithBlock;
    if (outcome === 'TASK_FAILED') return RUNTIME_EXIT_CODES.failed;
    return RUNTIME_EXIT_CODES.completed;
  } catch (error) {
    logger.error('execution_failed', logContext, { message: (error as Error).message });
    await terminal.emitTerminalOnce('TASK_FAILED');
    return RUNTIME_EXIT_CODES.failed;
  } finally {
    // Whatever happened, the tokens die with the process — and are gone before it ends.
    context.tokens.clear();
    await terminal.emitTerminalOnce('TASK_FAILED');
  }
}

process.exit(await main());
