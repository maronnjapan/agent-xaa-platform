import type { LogContext, Logger } from '@xaa/logging';
import { emitProtocolValidation } from '@xaa/contracts';

/**
 * `unauthorized_tool` goes to Cloud Logging, on the security channel.
 *
 * The Activity Event for the same rejection goes to Pub/Sub, on the display channel.
 * RULE-55 keeps the two apart, and so does this file: nothing here publishes, and the
 * activity publisher does not call this. One rejection produces one of each, written
 * by two callers, so a change to either channel cannot silently take the other with it.
 */
export function emitUnauthorizedTool(
  logger: Logger,
  ctx: LogContext,
  fields: { tool_id: string; reason: string; required_capability?: string },
  now: () => number = () => Date.now(),
): void {
  // Through the shared emitter: the event name and the eight required fields live in
  // `@xaa/contracts`, so this refusal reads the same as every other one (T-SEC-11).
  emitProtocolValidation(logger, ctx, {
    code: 'unauthorized_tool',
    outcome: 'fail',
    validation_name: 'unauthorized_tool',
    human_subject: ctx.human_subject,
    agent_id: ctx.agent_id,
    occurred_at: new Date(now()).toISOString(),
    path: 'agent-runtime:tool_call',
    trace_id: ctx.trace_id,
  }, fields);
}
