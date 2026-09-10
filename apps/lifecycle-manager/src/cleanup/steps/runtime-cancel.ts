import { isJobExecutionName } from '@xaa/contracts';
import type { CleanupContext } from '../../clients/types.js';

/**
 * step1. Stops the Job Execution the agent is running in.
 *
 * Three outcomes count as done, not one: the execution was cancelled, it was never
 * created, or it had already finished. Cleanup runs repeatedly by design — the sweep
 * retries what failed — so treating "already gone" as an error would leave every
 * subsequent pass stuck on the first step.
 *
 * Nothing here deletes a Service or a Job *definition*. Those are Terraform's, and an
 * execution is the only thing this step is entitled to touch.
 */
export async function runtimeCancel(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const name = context.domain.job_execution_name;
  // Cleanup can start before the execution was ever launched, and the field has held a
  // name that was never an execution's: the Provisioner wrote `runJob`'s operation name
  // there. A record like that has nothing to cancel, and the Executions API says so
  // with a refusal rather than a 404 — which would take the whole cleanup down with it,
  // every sweep, on a step whose only job is to stop something already stopping.
  if (!isJobExecutionName(name)) return 'skipped';
  const outcome = await context.clients.cloudRun.cancelExecution(name);
  return outcome === 'not_found' ? 'skipped' : 'succeeded';
}
