import { decodeJwsUnverified } from '@xaa/crypto';
import type { LogContext, Logger } from '@xaa/logging';

export const AS_LOG_FIELDS = [
  'idjag_iss', 'idjag_sub', 'idjag_act_sub', 'idjag_client_id', 'idjag_jti', 'received_kid', 'received_typ',
  'audience', 'resource', 'scope', 'cnf_jkt_match', 'token_issued',
] as const;

export interface IdJagRedemptionLog {
  idjag_iss: string | null;
  idjag_sub: string | null;
  idjag_act_sub: string | null;
  idjag_client_id: string | null;
  idjag_jti: string | null;
  received_kid: string | null;
  received_typ: string | null;
  audience: string | null;
  resource: string | null;
  scope: string | null;
  cnf_jkt_match: boolean | null;
  token_issued: boolean;
  authorization_decision: string;
  validation_name: string | null;
}

/**
 * REQ-09-011. `jti`, `kid` and `typ` are the join keys against Agent OP's issuance
 * ledger, so they are read from the assertion even when verification failed: an
 * ID-JAG signed with an Agent OP kid that has no matching issuance record is what
 * `signing_key_misuse` looks like.
 *
 * The assertion, the issued Access Token and the DPoP proof are never logged; the
 * thumbprint is a public value and may be.
 */
export function inspectAssertion(assertion: string | undefined): Pick<IdJagRedemptionLog, 'idjag_jti' | 'received_kid' | 'received_typ' | 'idjag_iss' | 'idjag_sub' | 'idjag_act_sub' | 'idjag_client_id' | 'audience' | 'resource'> {
  const empty = {
    idjag_jti: null, received_kid: null, received_typ: null, idjag_iss: null, idjag_sub: null,
    idjag_act_sub: null, idjag_client_id: null, audience: null, resource: null,
  };
  if (!assertion) return empty;
  try {
    const { header, payload } = decodeJwsUnverified(assertion);
    const actor = payload.act as { sub?: unknown } | undefined;
    const asString = (value: unknown) => (typeof value === 'string' ? value : null);
    return {
      idjag_jti: asString(payload.jti),
      received_kid: asString(header.kid),
      received_typ: asString(header.typ),
      idjag_iss: asString(payload.iss),
      idjag_sub: asString(payload.sub),
      idjag_act_sub: asString(actor?.sub),
      idjag_client_id: asString(payload.client_id),
      audience: Array.isArray(payload.aud) ? payload.aud.join(' ') : asString(payload.aud),
      resource: Array.isArray(payload.resource) ? payload.resource.join(' ') : asString(payload.resource),
    };
  } catch {
    return empty;
  }
}

export function logIdJagRedemption(logger: Logger, context: LogContext, entry: IdJagRedemptionLog): void {
  logger.info('resource_as.redeem', context, { ...entry });
}
