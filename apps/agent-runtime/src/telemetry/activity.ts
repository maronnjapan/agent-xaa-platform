import { randomUUID } from 'node:crypto';
import { publishActivityEvent, type ActivityEvent, type ToolManifest } from '@xaa/contracts';
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
}): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  await publish({
    ...base(input.context, occurredAt),
    phase: 'tool_call',
    outcome: 'success',
    title: 'ツールを実行しました',
    message: `${input.toolId} を実行し、結果を受け取りました。`,
    detail: { event_type: 'TOOL_SUCCEEDED', tool_id: input.toolId },
  }, input.logger, input.ctx);
}

export async function publishToolBlocked(input: {
  context: ActivityContext;
  toolId: string;
  reason: string;
  logger: Logger;
  ctx: LogContext;
  occurredAt?: string;
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
    },
  }, input.logger, input.ctx);
}

export async function publishTaskOutcome(input: {
  context: ActivityContext;
  eventType: 'TASK_COMPLETED' | 'TASK_BLOCKED' | 'TASK_FAILED';
  logger: Logger;
  ctx: LogContext;
  occurredAt?: string;
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
  }, input.logger, input.ctx);
}
