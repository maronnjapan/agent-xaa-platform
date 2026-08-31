import type { LogContext, Logger } from '@xaa/logging';

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
): void {
  logger.warning('protocol_validation', ctx, { validation: 'unauthorized_tool', ...fields });
}
