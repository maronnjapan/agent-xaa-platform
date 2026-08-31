/**
 * Every refusal the Bridge can produce.
 *
 * OAuth error codes are deliberately coarse: `invalid_grant` covers a bad signature, an
 * unknown issuer, a missing binding and an expired connection alike. Telling a caller
 * which of those it was would help someone probing for a working combination; the
 * detail goes to the structured log, where the operator can see it and the caller
 * cannot.
 */
export const BRIDGE_ERRORS = [
  'invalid_grant', 'invalid_dpop_proof', 'invalid_scope', 'invalid_target',
  'unsupported_grant_type', 'connection_revoked', 'forbidden_caller',
  'invalid_transaction', 'invalid_state', 'code_already_used',
  'scope_not_in_connection', 'human_subject_mismatch', 'expires_at_too_far',
  'binding_already_exists', 'invalid_request',
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERRORS)[number];

export class BridgeError extends Error {
  constructor(readonly code: BridgeErrorCode, readonly status: number, readonly detail?: string) {
    super(code);
  }
}

export const PROTOCOL_VALIDATIONS = [
  'forbidden_bridge_caller', 'invalid_bridge_binding', 'expired_bridge_connection',
  'bridge_scope_violation', 'invalid_dpop_proof', 'replayed_dpop_proof',
] as const;

export type BridgeProtocolValidation = (typeof PROTOCOL_VALIDATIONS)[number];
