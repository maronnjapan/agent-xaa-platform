import type { LogContext, Logger } from '@xaa/logging';

export function logApiAccess(logger: Logger, context: LogContext, input: {
  tool_id: string;
  operation: string;
  method: string;
  resource: string;
  status: number;
  outcome: string;
  latency_ms: number;
  human_subject: string | null;
  agent_id: string | null;
}): void {
  logger.info('resource_api.access', { ...context, human_subject: input.human_subject, agent_id: input.agent_id }, {
    tool_id: input.tool_id,
    operation: input.operation,
    http_method: input.method,
    resource: input.resource,
    response_status: input.status,
    outcome: input.outcome,
    latency_ms: Math.round(input.latency_ms),
  });
}
