import { decodeJwsUnverified } from '@xaa/crypto';
import type { LogContext, Logger } from '@xaa/logging';

export const AS_LOG_FIELDS = [
  'id_jag_iss', 'id_jag_sub', 'id_jag_act', 'id_jag_client_id', 'idjag_jti', 'received_kid', 'received_typ',
  'audience', 'resource', 'scope', 'cnf_jkt', 'dpop_binding_result', 'token_issue_result',
  'dpop_binding_step', 'expected_jkt', 'presented_jkt', 'expected_htu', 'presented_htu',
] as const;

export interface IdJagRedemptionLog {
  id_jag_iss: string | null;
  id_jag_sub: string | null;
  id_jag_act: string | null;
  id_jag_client_id: string | null;
  idjag_jti: string | null;
  received_kid: string | null;
  received_typ: string | null;
  audience: string | null;
  resource: string | null;
  scope: string | null;
  /** The `cnf.jkt` thumbprint actually bound to the redeemed ID-JAG, once known. */
  cnf_jkt: string | null;
  dpop_binding_result: boolean | null;
  /**
   * What the confirmation binding compared, when it refused. `dpop_key_binding_mismatch`
   * on its own cannot separate a stolen key from two sides that disagree about the
   * token endpoint; these five name which it was. All are public values (a thumbprint
   * comes from a public key, an `htu` is a URL) and all are null on the accepted path.
   */
  dpop_binding_step: string | null;
  expected_jkt: string | null;
  presented_jkt: string | null;
  expected_htu: string | null;
  presented_htu: string | null;
  token_issue_result: boolean;
  authz_decision: string;
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
export function inspectAssertion(assertion: string | undefined): Pick<IdJagRedemptionLog, 'idjag_jti' | 'received_kid' | 'received_typ' | 'id_jag_iss' | 'id_jag_sub' | 'id_jag_act' | 'id_jag_client_id' | 'audience' | 'resource'> {
  const empty = {
    idjag_jti: null, received_kid: null, received_typ: null, id_jag_iss: null, id_jag_sub: null,
    id_jag_act: null, id_jag_client_id: null, audience: null, resource: null,
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
      id_jag_iss: asString(payload.iss),
      id_jag_sub: asString(payload.sub),
      id_jag_act: asString(actor?.sub),
      id_jag_client_id: asString(payload.client_id),
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
