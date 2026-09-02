import type { LogContext, Logger } from '@xaa/logging';
import { emitProtocolValidation as emitValidation } from '@xaa/contracts';
import type { BridgeProtocolValidation } from '../errors.js';

export const BRIDGE_LOG_FIELDS = [
  'id_jag_iss', 'id_jag_verify_result', 'connection_id', 'requested_resource', 'requested_scope',
  'agent_expiry_check', 'google_refresh_result', 'access_token_issue_result',
] as const;

/** Never logged, whatever key they arrive under. */
export const ALWAYS_DROPPED = [
  'access_token', 'refresh_token', 'client_secret', 'assertion', 'code', 'code_verifier', 'state',
] as const;

export interface BridgeTokenLog {
  id_jag_iss: string;
  id_jag_verify_result: string;
  connection_id: string;
  requested_resource: string;
  requested_scope: string;
  agent_expiry_check: string;
  google_refresh_result: string;
  access_token_issue_result: 'issued' | 'denied';
}

export class DisallowedLogField extends Error {}

/**
 * One line per `/token` request, with the same seven fields whether it succeeded or not.
 *
 * Stages the request never reached are written as `"skipped"` rather than omitted. A
 * missing field and a field that says "we did not get there" look identical in a query
 * otherwise, and the difference is exactly what an operator is looking for.
 *
 * An unexpected key throws in development and is dropped in production: a mistake
 * should be loud where someone will see it, and harmless where nobody can fix it now.
 */
export function emitBridgeTokenLog(
  logger: Logger,
  context: LogContext,
  fields: BridgeTokenLog,
  options: { production?: boolean } = {},
): void {
  const allowed = new Set<string>(BRIDGE_LOG_FIELDS);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if ((ALWAYS_DROPPED as readonly string[]).includes(key)) continue;
    if (!allowed.has(key)) {
      if (!options.production) throw new DisallowedLogField(key);
      continue;
    }
    output[key] = value;
  }
  logger.info('bridge_token_exchange', context, output);
}

/**
 * The Bridge's refusals, on the platform's one protocol-validation event.
 *
 * It delegates rather than writing its own line: the event name lives in
 * `@xaa/contracts` so there is exactly one producer, and the eight required fields are
 * filled here so a Bridge refusal reads the same as a Control Plane one on the detection
 * side (T-SEC-11).
 */
export function emitProtocolValidation(
  logger: Logger,
  context: LogContext,
  validation: BridgeProtocolValidation,
  fields: Record<string, unknown> = {},
  now: () => number = () => Date.now(),
): void {
  emitValidation(logger, context, {
    code: validation,
    outcome: 'fail',
    validation_name: validation,
    human_subject: context.human_subject,
    agent_id: context.agent_id,
    occurred_at: new Date(now()).toISOString(),
    path: 'google-bridge:/token',
    trace_id: context.trace_id,
  }, fields);
}

/** The callback face logs what happened, never the values that made it happen. */
export function emitCallbackLog(
  logger: Logger,
  context: LogContext,
  fields: { connector_id: string; transaction_id: string; result: string },
): void {
  logger.info('bridge_consent_callback', context, fields);
}
