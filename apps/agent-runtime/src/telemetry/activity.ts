import { randomUUID } from 'node:crypto';
import { publishActivityEvent, type ActivityEvent, type ActivityRecord, type ToolManifest } from '@xaa/contracts';
import type { LogContext, Logger } from '@xaa/logging';

export interface ActivityContext {
  humanSubject: string;
  agentId: string;
  taskId: string;
  traceId: string;
  manifest: ToolManifest;
}

/** The capabilities this agent actually holds, read off the manifest it was given. */
export function effectiveCapabilities(manifest: ToolManifest): string[] {
  return [...new Set(manifest.tools.map((tool) => tool.required_capability))].sort();
}

function base(context: ActivityContext, occurredAt: string): Omit<ActivityEvent, 'phase' | 'outcome' | 'title' | 'message' | 'detail'> {
  return {
    event_id: randomUUID(),
    trace_id: context.traceId,
    human_subject: context.humanSubject,
    agent_id: context.agentId,
    task_id: context.taskId,
    occurred_at: occurredAt,
    source: 'agent-runtime',
    related_finding_id: null,
    // A literal, not a parameter. `is_simulated` marks a scripted demo row, and a
    // runtime that could set it would be able to disown a real action.
    is_simulated: false,
  };
}

/**
 * Publishing must never decide whether the work happened.
 *
 * A dropped Pub/Sub message costs a row in a timeline; a tool call failed because its
 * telemetry failed would cost the user their task. So a publish error is logged and
 * swallowed here, at the one place that knows the difference.
 */
async function publish(event: ActivityEvent, logger: Logger, ctx: LogContext): Promise<void> {
  try {
    await publishActivityEvent(event);
  } catch (error) {
    logger.warning('activity_publish_failed', ctx, { message: (error as Error).message });
  }
}

export async function publishToolSucceeded(input: {
  context: ActivityContext;
  toolId: string;
  logger: Logger;
  ctx: LogContext;
  occurredAt?: string;
  record?: ActivityRecord;
}): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  await publish({
    ...base(input.context, occurredAt),
    phase: 'tool_call',
    outcome: 'success',
    title: 'ツールを実行しました',
    message: `${input.toolId} を実行し、結果を受け取りました。`,
    // `target` is what the canvas draws the arrow towards. A successful call ends at
    // the resource, and the hops inside the record say how it got there.
    detail: { event_type: 'TOOL_SUCCEEDED', tool_id: input.toolId, target: 'resource-api' },
    ...(input.record ? { record: input.record } : {}),
  }, input.logger, input.ctx);
}

/**
 * A tool call that neither worked nor was refused.
 *
 * Nothing published this before, so a run where every call failed on a 503 produced
 * one terminal event and no explanation — the timeline showed a task that ended and
 * nothing that happened inside it. `outcome` is `info` rather than `blocked` for the
 * same reason TASK_FAILED is: nobody decided this agent may not act (docs 11 §3.1).
 */
export async function publishToolFailed(input: {
  context: ActivityContext;
  toolId: string;
  errorCode: string;
  logger: Logger;
  ctx: LogContext;
  occurredAt?: string;
  record?: ActivityRecord;
}): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  await publish({
    ...base(input.context, occurredAt),
    phase: 'tool_call',
    outcome: 'info',
    title: 'ツールを実行できませんでした',
    message: `${input.toolId} は ${input.errorCode} のため完了しませんでした。`,
    detail: { event_type: 'TOOL_FAILED', tool_id: input.toolId, error_code: input.errorCode },
    ...(input.record ? { record: input.record } : {}),
  }, input.logger, input.ctx);
}

export async function publishToolBlocked(input: {
  context: ActivityContext;
  toolId: string;
  reason: string;
  logger: Logger;
  ctx: LogContext;
  occurredAt?: string;
  record?: ActivityRecord;
}): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  await publish({
    ...base(input.context, occurredAt),
    phase: 'tool_call',
    outcome: 'blocked',
    // Written here, in Japanese, rather than assembled by the screen: the timeline is
    // a record of what was said at the time, and a renderer that rephrases it later
    // would rewrite history when its wording changes.
    title: '権限外の操作を拒否しました',
    message: `${input.toolId} は、このエージェントに許可されたツールに含まれていないため実行しませんでした。`,
    detail: {
      event_type: 'TOOL_BLOCKED',
      tool_id: input.toolId,
      effective_capabilities: effectiveCapabilities(input.context.manifest),
      reason: input.reason,
      // The refusal is drawn as an arrow towards the resource that stops short of it,
      // which needs a destination even though nothing was sent (docs 11 §5.2).
      target: 'resource-api',
    },
    ...(input.record ? { record: input.record } : {}),
  }, input.logger, input.ctx);
}

export async function publishTaskOutcome(input: {
  context: ActivityContext;
  eventType: 'TASK_COMPLETED' | 'TASK_BLOCKED' | 'TASK_FAILED';
  logger: Logger;
  ctx: LogContext;
  occurredAt?: string;
  record?: ActivityRecord;
}): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const wording = {
    TASK_COMPLETED: { outcome: 'success' as const, title: '作業が完了しました', message: '指示された作業をすべて完了しました。' },
    TASK_BLOCKED: { outcome: 'blocked' as const, title: '作業を途中で止めました', message: '権限の範囲外の操作が含まれていたため、その操作を実行せずに終了しました。' },
    // `outcome` has three values by design (docs 11 §3.1); a failure is not a block,
    // so it carries the neutral tone and states the difference in the message.
    TASK_FAILED: { outcome: 'info' as const, title: '作業を完了できませんでした', message: '処理中にエラーが発生したため、作業を完了できませんでした。' },
  }[input.eventType];
  await publish({
    ...base(input.context, occurredAt),
    phase: 'tool_call',
    outcome: wording.outcome,
    title: wording.title,
    message: wording.message,
    detail: { event_type: input.eventType },
    ...(input.record ? { record: input.record } : {}),
  }, input.logger, input.ctx);
}
