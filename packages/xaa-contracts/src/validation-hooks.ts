import type { ProtocolViolationCode } from './protocol-violation.js';

/**
 * The eight checks a Control Plane request passes, and the code each failure is
 * reported under (T-SEC-12, REQ-05-014 to REQ-05-021).
 *
 * The keys are the names the design uses in prose; the values are the codes the
 * detection queries key on. Keeping the pair in one table is what stops a middleware
 * from inventing a ninth name, or from reporting two different checks under one code —
 * either of which makes a saved query silently stop matching.
 *
 * The order is the order the checks run in (DEC-ID-12, DEC-ID-18): signature, then
 * expiry, then audience, then scope, then the DPoP proof and its binding, then the
 * human subject. Only the first failure is reported, so the position of a name here is
 * also a statement about which of two broken things is named.
 */
export const VALIDATION_NAME_TO_CODE = {
  'invalid signature': 'invalid_signature',
  'expired token': 'expired_token',
  'audience mismatch': 'audience_mismatch',
  'invalid scope': 'invalid_scope',
  'invalid DPoP proof': 'invalid_dpop_proof',
  'replayed DPoP proof': 'replayed_dpop_proof',
  'DPoP key binding mismatch': 'dpop_key_binding_mismatch',
  'human_subject mismatch': 'human_subject_mismatch',
} as const satisfies Readonly<Record<string, ProtocolViolationCode>>;

export type ValidationName = keyof typeof VALIDATION_NAME_TO_CODE;

/**
 * The same eight, as the tuple the guard's own union type is built from, in check order.
 */
export const CONTROL_PLANE_VALIDATION_CODES = [
  'invalid_signature', 'expired_token', 'audience_mismatch', 'invalid_scope',
  'invalid_dpop_proof', 'replayed_dpop_proof', 'dpop_key_binding_mismatch', 'human_subject_mismatch',
] as const satisfies readonly ProtocolViolationCode[];

export type ControlPlaneValidationCode = (typeof CONTROL_PLANE_VALIDATION_CODES)[number];

/** `<app>:<route template>`; never a real URL and never a query string (T-SEC-12). */
export function validationPath(app: string, routeTemplate: string): string {
  return `${app}:${routeTemplate}`;
}
