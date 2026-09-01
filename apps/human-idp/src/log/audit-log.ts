import { AUTH_RESULTS, DPOP_STATUS, type AuthResult, type DpopStatusValue } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';

export interface HumanIdpAuditEvent {
  client_id: string | null;
  audience: string | string[] | null;
  scope: string | null;
  auth_result: AuthResult;
  failure_code: string | null;
  dpop_status: DpopStatusValue;
  source_ip: string | null;
  user_agent: string | null;
}

export interface HumanIdpAuditContext {
  human_subject: string | null;
  trace_id: string;
}

const TOKEN_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}/;

/**
 * docs 09 §2 (Human IdP row) and RULE-38. One JSON line on stdout; Cloud Logging
 * picks it up. `agent_id` is always null and never omitted: Human IdP does not know
 * about agents, and a missing key would break the shared correlation schema.
 *
 * Written from exactly three places: the end of /authorize, just before the /token
 * response, and just before the /revoke response.
 */
export function emitHumanIdpAudit(
  event: HumanIdpAuditEvent,
  context: HumanIdpAuditContext,
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  if (TOKEN_SHAPE.test(JSON.stringify(event))) throw new Error('audit log entry contains a raw token');
  // The shared envelope, because the Log Sink keeps a line only when it carries a
  // `log_source` and Security Detection picks its converter by the same field. Written
  // bare, these records were dropped before either saw them (T-SEC-05).
  createLogger('human-idp', 'human_idp', write).info('idp_authenticate', {
    request_id: '',
    trace_id: context.trace_id,
    // Human IdP does not know about agents, and the key is present rather than omitted
    // so the shared correlation schema still validates.
    agent_id: null,
    human_subject: context.human_subject,
  }, { ...event });
}

/** Extracts the trace id from Cloud Run's header, generating one when absent. */
export function traceIdFrom(header: string | null | undefined): string {
  const value = header?.split('/')[0];
  return value && value.length > 0 ? value : crypto.randomUUID();
}

export { AUTH_RESULTS, DPOP_STATUS };

export interface AuditHooks {
  authorize(event: Partial<HumanIdpAuditEvent> & Pick<HumanIdpAuditEvent, 'auth_result'>, request: Request, subject?: string | null): void;
  token(event: Partial<HumanIdpAuditEvent> & Pick<HumanIdpAuditEvent, 'auth_result'>, request: Request, subject?: string | null): void;
  revoke(event: Partial<HumanIdpAuditEvent> & Pick<HumanIdpAuditEvent, 'auth_result'>, request: Request, subject?: string | null): void;
}

/**
 * The three call sites the design allows. Building them here keeps the emission
 * points explicit in the routes while the field assembly stays in one place.
 */
export function createAuditHooks(write?: (line: string) => void): AuditHooks {
  const emit = (dpopDefault: DpopStatusValue) =>
    (event: Partial<HumanIdpAuditEvent> & Pick<HumanIdpAuditEvent, 'auth_result'>, request: Request, subject?: string | null) => {
      emitHumanIdpAudit({
        client_id: event.client_id ?? null,
        audience: event.audience ?? null,
        scope: event.scope ?? null,
        auth_result: event.auth_result,
        failure_code: event.auth_result === 'success' ? null : event.failure_code ?? 'invalid_request',
        dpop_status: event.dpop_status ?? dpopDefault,
        source_ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        user_agent: request.headers.get('user-agent'),
      }, {
        human_subject: subject ?? null,
        trace_id: traceIdFrom(request.headers.get('x-cloud-trace-context')),
      }, write);
    };
  return {
    // /authorize is a browser redirect: a proof cannot be produced there.
    authorize: emit(DPOP_STATUS.not_applicable),
    token: emit(DPOP_STATUS.absent),
    revoke: emit(DPOP_STATUS.not_applicable),
  };
}
