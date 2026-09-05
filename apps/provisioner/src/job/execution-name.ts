import { isJobExecutionName } from '@xaa/contracts';

/**
 * The Execution a run started, read off the operation that started it.
 *
 * `Jobs.runJob` answers with a long-running operation whose `name` is the operation's,
 * not the execution's, and that is the name the registration used to keep. Lifecycle
 * cancels an agent by reading `job_execution_name`, so `step1` of every cleanup was
 * being handed `projects/{p}/locations/{l}/operations/{uuid}` — a name no Execution has
 * ever had, and one the Executions API answers for with a refusal rather than a stop.
 *
 * The Execution itself is the operation's metadata, which Cloud Run fills in on the
 * first response: `runJob`'s long-running operation completes when the execution does,
 * so waiting for it would mean waiting out the agent's whole lifetime to learn a name
 * that was there from the start.
 *
 * The shape is checked rather than assumed. What this reads is an untyped metadata bag,
 * and the one thing worse than not recording the execution is recording something else
 * under its name.
 */
export function startedExecutionName(operation: { metadata?: unknown }): string | undefined {
  const started = operation.metadata as { name?: unknown } | null | undefined;
  return isJobExecutionName(started?.name) ? started.name : undefined;
}
