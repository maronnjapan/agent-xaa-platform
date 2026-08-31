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
 */
export const PROVISIONING_STEPS = [
  'create_transaction',
  'resolve_tools',
  'generate_agent_identity',
  'set_expires_at',
  'idp_consent',
  'verify_idp_connection',
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

export interface RunResult {
  completed: ProvisioningStep[];
  failedAt?: ProvisioningStep;
  compensated: ProvisioningStep[];
  compensationFailures: Array<{ step: ProvisioningStep; error: string }>;
}

/**
 * Runs the steps in order and, on failure, undoes what succeeded in reverse.
 *
 * A compensation that itself fails does not stop the rest: leaving four resources
 * behind because the fifth refused to delete is worse than reporting five problems.
 * The failures are collected and logged together.
 */
export async function runProvisioning(steps: Step[], context: StepContext, logger?: Logger): Promise<RunResult> {
  const completed: ProvisioningStep[] = [];
  const result: RunResult = { completed, compensated: [], compensationFailures: [] };

  for (const [index, step] of steps.entries()) {
    const expected = PROVISIONING_STEPS[PROVISIONING_STEPS.indexOf(steps[0]!.id) + index];
    if (expected !== undefined && step.id !== expected) throw new PreconditionFailed(expected, step.id);
    try {
      await step.run(context);
      completed.push(step.id);
    } catch (error) {
      result.failedAt = step.id;
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
