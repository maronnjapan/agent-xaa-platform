import { createLogger, type LogContext } from '@xaa/logging';

const logger = createLogger('human-idp', 'human_idp');

export interface RefreshTokenReuseEvent {
  grantId: string;
  clientId?: string;
  subject?: string;
  jti?: string;
}

/**
 * REQ-05-050 / docs 09 §5.1. Emitted once per detected reuse. The refresh token
 * value never appears: the grant id, the client and the jti are enough to correlate
 * in BigQuery, and RULE-38 forbids raw tokens in logs.
 */
export function emitRefreshTokenReuse(event: RefreshTokenReuseEvent, context?: Partial<LogContext>): void {
  logger.warning('refresh_token_reuse', {
    request_id: context?.request_id ?? '',
    trace_id: context?.trace_id ?? '',
    agent_id: null,
    human_subject: event.subject ?? context?.human_subject ?? null,
  }, {
    event_type: 'refresh_token_reuse',
    grant_id: event.grantId,
    client_id: event.clientId ?? null,
    jti: event.jti ?? null,
  });
}
