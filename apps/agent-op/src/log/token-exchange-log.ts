import { AGENT_URN_PREFIX } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
/**
 * docs 09 §2, the fourteen fields of a Token Exchange record.
 *
 * Every field is a string, a boolean or a number. No field can hold a token: the
 * type itself is what keeps a compact JWS out of the log (RULE-38).
 */
export interface TokenExchangeTrace {
  op_runtime_id: string;
  op_kind: 'shared' | 'dedicated';
  requested_audience: string | null;
  requested_resource: string | null;
  requested_scope: string | null;
  subject_token_iss: string | null;
  subject_token_aud: string | null;
  subject_token_sub: string | null;
  actor_token_sub: string | null;
  actor_token_jti: string | null;
  delegation_check: boolean | null;
  dpop_result: string;
  issued_id_jag: { jti: string; kid: string; cnf_jkt: string } | null;
  agent_expiry_check: 'ok' | 'expired' | 'not_active' | null;
  error_code: string | null;
}

export function createTrace(options: { revision: string; kind: 'shared' | 'dedicated' }): TokenExchangeTrace {
  return {
    op_runtime_id: options.revision,
    op_kind: options.kind,
    requested_audience: null,
    requested_resource: null,
    requested_scope: null,
    subject_token_iss: null,
    subject_token_aud: null,
    subject_token_sub: null,
    actor_token_sub: null,
    actor_token_jti: null,
    delegation_check: null,
    dpop_result: 'ok',
    issued_id_jag: null,
    agent_expiry_check: null,
    error_code: null,
  };
}

const COMPACT_JWS = /\beyJ[A-Za-z0-9_-]{8,}/;

/**
 * One record per request, written from the route's finally block — never one line
 * per step. BigQuery receives it through the log sink, not from the app (DEC-SEC-01).
 *
 * The shared logger's envelope is not decoration: the Log Sink's filter is
 * `jsonPayload.log_source != ""`, and Security Detection's normalizer dispatches on
 * the same field. A bare record is dropped before it reaches either (T-SEC-05).
 */
export function emitTokenExchangeLog(
  trace: TokenExchangeTrace,
  write: (line: string) => void = (line) => process.stdout.write(line),
  correlation: { requestId?: string; traceId?: string } = {},
): void {
  if (COMPACT_JWS.test(JSON.stringify(trace))) throw new Error('token exchange log must not contain a compact JWS');
  createLogger('shared-agent-op', 'agent_op', write).info('token_exchange', {
    request_id: correlation.requestId ?? '',
    trace_id: correlation.traceId ?? '',
    // The two subjects the record already carries: the agent that asked, and the
    // person it asked for. The detector correlates on these, so they belong in the
    // envelope rather than only in the fields.
    agent_id: agentIdFrom(trace.actor_token_sub),
    human_subject: trace.subject_token_sub,
  }, { ...trace });
}

function agentIdFrom(actorSub: string | null): string | null {
  if (!actorSub) return null;
  const agentId = actorSub.startsWith(AGENT_URN_PREFIX) ? actorSub.slice(AGENT_URN_PREFIX.length) : actorSub;
  return agentId.length > 0 ? agentId : null;
}
