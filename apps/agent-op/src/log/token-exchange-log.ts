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
 */
export function emitTokenExchangeLog(trace: TokenExchangeTrace, write: (line: string) => void = (line) => process.stdout.write(line)): void {
  const line = JSON.stringify({ logName: 'agent_op_token_exchange', ...trace });
  if (COMPACT_JWS.test(line)) throw new Error('token exchange log must not contain a compact JWS');
  write(`${line}\n`);
}
