import type { DocumentStore } from '@xaa/gcp';
import type { Logger, LogContext } from '@xaa/logging';
import { CLEANUP_LOCK_SECONDS, CLEANUP_MAX_ATTEMPTS, type CleanupReason } from '../config.js';
import { loadDomain, type AgentIdentityDomain } from '../domain.js';
import { writeStatus } from '../status-writer.js';
import { InvalidTransitionError } from '../state-machine.js';
import type { CleanupClients } from '../clients/types.js';
import { CLEANUP_STEPS } from './steps.js';
import { isDone, mergeResult, type CleanupOutcome, type CleanupStepResult } from './result.js';

export interface CleanupDeps {
  documents: DocumentStore;
  clients: CleanupClients;
  logger: Logger;
  logContext: LogContext;
  now?: () => number;
  holder?: string;
  onDestroyed?(domain: AgentIdentityDomain, reason: CleanupReason): Promise<void>;
}

/**
 * Destroys one agent, in eleven steps, as many times as it takes.
 *
 * Two properties shape the whole design. It never gives up partway: a step that fails
 * is recorded and the remaining ten still run, because the alternative is an agent
 * whose tokens were revoked but whose Job is still executing. And it is idempotent: a
 * step already `succeeded` or `skipped` is not re-run, so the sweep can call this
 * repeatedly and only the unfinished work happens again.
 *
 * DESTROYED is reached only when nothing is outstanding. While a single step is
 * `failed` the agent stays REVOKED — visibly unfinished — rather than being marked
 * complete with something still alive.
 */
export async function cleanupAgent(
  agentId: string,
  reason: CleanupReason,
  deps: CleanupDeps,
): Promise<CleanupOutcome> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = new Date(now()).toISOString();
  const holder = deps.holder ?? 'lifecycle-manager';

  if (!await acquireLock({ documents: deps.documents, agentId, holder, now })) {
    return { agent_id: agentId, reason, status: 'REVOKED', results: [] };
  }

  const domain = await loadDomain(deps.documents, agentId);
  // Already REVOKED is the normal case on a retry; the transition is attempted once and
  // its refusal is not an error.
  try {
    await writeStatus({ documents: deps.documents, agentId, to: 'REVOKED', reason, now: now() });
  } catch (error) {
    if (!(error instanceof InvalidTransitionError)) throw error;
  }

  let results: CleanupStepResult[] = [...(domain.cleanup_step_results as CleanupStepResult[])];
  for (const step of CLEANUP_STEPS) {
    const previous = results.find((entry) => entry.step === step.id);
    if (isDone(previous)) continue;
    const attempts = (previous?.attempts ?? 0) + 1;
    if (attempts > CLEANUP_MAX_ATTEMPTS) {
      // Exhausted, and left alone from here: an unbounded retry would turn one broken
      // dependency into a sweep that never finishes anything else.
      deps.logger.warning('cleanup_exhausted', deps.logContext, { agent_id: agentId, step: step.id });
      continue;
    }
    let result: CleanupStepResult;
    try {
      const status = await step.run({
        domain, reason, clients: deps.clients, logger: deps.logger, logContext: deps.logContext,
        documents: deps.documents, now, startedAt, stepResults: results,
      });
      result = { step: step.id, status, attempts, last_error_code: null, updated_at: new Date(now()).toISOString() };
    } catch (error) {
      result = {
        step: step.id, status: 'failed', attempts,
        last_error_code: (error as Error).message.slice(0, 64),
        updated_at: new Date(now()).toISOString(),
      };
    }
    results = mergeResult(results, result);
    await saveResults(deps.documents, agentId, results).catch(() => undefined);
  }

  const complete = CLEANUP_STEPS.every((step) => isDone(results.find((entry) => entry.step === step.id)));
  if (!complete) {
    await releaseLock({ documents: deps.documents, agentId });
    return { agent_id: agentId, reason, status: 'REVOKED', results };
  }

  // The audit step has already removed the document, so the DESTROYED write is best
  // effort: the agent is gone either way, and the terminal event below is what a person
  // actually sees.
  await writeStatus({ documents: deps.documents, agentId, to: 'DESTROYED', reason, now: now() }).catch(() => undefined);
  await deps.onDestroyed?.(domain, reason);
  return { agent_id: agentId, reason, status: 'DESTROYED', results };
}

async function saveResults(documents: DocumentStore, agentId: string, results: CleanupStepResult[]): Promise<void> {
  await documents.update('agents', `${agentId}__meta`, { cleanup_step_results: results });
}

/**
 * One cleanup per agent at a time, claimed by compare-and-set.
 *
 * A lock older than five minutes can be taken: the holder was a request that died, and
 * leaving the agent uncleanable forever is worse than two overlapping runs — which the
 * per-step results already make safe.
 */
async function acquireLock(input: {
  documents: DocumentStore;
  agentId: string;
  holder: string;
  now: () => number;
}): Promise<boolean> {
  return input.documents.transaction(async (tx) => {
    const meta = await tx.get<{ cleanup_lock?: { holder: string; acquired_at: string } }>(
      'agents', `${input.agentId}__meta`,
    );
    if (!meta) return false;
    const lock = meta.cleanup_lock;
    if (lock && input.now() - Date.parse(lock.acquired_at) < CLEANUP_LOCK_SECONDS * 1000) return false;
    tx.update('agents', `${input.agentId}__meta`, {
      cleanup_lock: { holder: input.holder, acquired_at: new Date(input.now()).toISOString() },
    });
    return true;
  });
}

async function releaseLock(input: { documents: DocumentStore; agentId: string }): Promise<void> {
  await input.documents.update('agents', `${input.agentId}__meta`, { cleanup_lock: null }).catch(() => undefined);
}
