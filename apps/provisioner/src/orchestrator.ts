import type { IsolationLevel } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';

/**
 * docs 07 §3.3, in order. The shape matters as much as the list:
 *
 * - the IdP connection is created and verified before any external consent, because
 *   an agent without a usable refresh token cannot act for anyone (RULE-51);
 * - the registration is written before the job starts, so an execution can never
 *   find itself unregistered;
 * - each step declares how to undo itself, and `noop` is written out rather than
 *   omitted, so "this step needs no compensation" is a decision on the record.
 *
 * `create_dedicated_resources` sits inside the list rather than beside it: T-PROV-28
 * gives it a compensation of its own, and a step that can be undone but has no place
 * in the order is a step whose undo nobody can schedule. It runs only on the
 * FULL_ISOLATION branch, which is why a run may skip it — see `runProvisioning`.
 */
export const PROVISIONING_STEPS = [
  'create_transaction',
  'resolve_tools',
  'generate_agent_identity',
  'set_expires_at',
  'idp_consent',
  'verify_idp_connection',
  'create_dedicated_resources',
  'external_consent',
  'create_agent_binding',
  'register_agent',
  'start_job_execution',
  'activate',
] as const;

export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];

export interface StepContext {
  agentId: string | null;
  isolationLevel: IsolationLevel;
  transactionId: string;
}

export interface Step {
  id: ProvisioningStep;
  run(context: StepContext): Promise<void>;
  compensate: 'noop' | ((context: StepContext) => Promise<void>);
}

export class PreconditionFailed extends Error {
  constructor(readonly expectedStep: ProvisioningStep, readonly actualStep: ProvisioningStep) {
    super('precondition_failed');
  }
}

/**
 * Stops the run without failing it. A provisioning that pauses for consent has done
 * nothing wrong, so nothing it did may be undone: the transaction stays alive and the
 * resume picks it up from `pending_step`.
 */
export class ProvisioningHalted extends Error {
  constructor(readonly at: ProvisioningStep) { super('provisioning_halted'); }
}

export interface RunResult {
  completed: ProvisioningStep[];
  failedAt?: ProvisioningStep;
  /** Set when a step asked to pause rather than fail; nothing is compensated. */
  haltedAt?: ProvisioningStep;
  /** What the failing step threw, so the caller can map it to a status code. */
  error?: unknown;
  compensated: ProvisioningStep[];
  compensationFailures: Array<{ step: ProvisioningStep; error: string }>;
}

/**
 * Runs the steps in order and, on failure, undoes what succeeded in reverse.
 *
 * A run may leave steps out — STANDARD creates no dedicated resources and no Bridge
 * binding — but it may never reorder them: the position in `PROVISIONING_STEPS` has to
 * increase with every entry, so a caller cannot register an agent before its IdP
 * connection was verified by handing the steps over in the wrong order.
 *
 * A compensation that itself fails does not stop the rest: leaving four resources
 * behind because the fifth refused to delete is worse than reporting five problems.
 * The failures are collected and logged together.
 */
export async function runProvisioning(steps: Step[], context: StepContext, logger?: Logger): Promise<RunResult> {
  const completed: ProvisioningStep[] = [];
  const result: RunResult = { completed, compensated: [], compensationFailures: [] };

  let previous = -1;
  for (const step of steps) {
    const position = PROVISIONING_STEPS.indexOf(step.id);
    if (position <= previous) throw new PreconditionFailed(PROVISIONING_STEPS[previous + 1]!, step.id);
    previous = position;
    try {
      await step.run(context);
      completed.push(step.id);
    } catch (error) {
      if (error instanceof ProvisioningHalted) {
        result.haltedAt = step.id;
        return result;
      }
      result.failedAt = step.id;
      result.error = error;
      for (const done of [...completed].reverse()) {
        const compensation = steps.find((candidate) => candidate.id === done)?.compensate;
        if (compensation === undefined || compensation === 'noop') continue;
        try {
          await compensation(context);
          result.compensated.push(done);
        } catch (compensationError) {
          result.compensationFailures.push({
            step: done,
            error: compensationError instanceof Error ? compensationError.message : 'unknown',
          });
        }
      }
      logger?.error('provisioner.rollback', {
        request_id: '', trace_id: '', agent_id: context.agentId, human_subject: null,
      }, {
        failed_at: step.id,
        error: error instanceof Error ? error.message : 'unknown',
        compensated: result.compensated,
        compensation_failures: result.compensationFailures,
      });
      return result;
    }
  }
  return result;
}
