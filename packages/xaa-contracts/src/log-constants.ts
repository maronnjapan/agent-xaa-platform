/**
 * Value domain of the `dpop_status` log field.
 *
 * - `valid`          a proof was presented and every check in DEC-ID-12 passed
 * - `invalid`        a proof was presented and some check failed
 * - `absent`         the endpoint accepts DPoP but no proof was presented
 * - `not_applicable` the endpoint never takes a proof (browser redirect paths)
 */
export const DPOP_STATUS = {
  valid: 'valid',
  invalid: 'invalid',
  absent: 'absent',
  not_applicable: 'not_applicable',
} as const;

export type DpopStatusValue = (typeof DPOP_STATUS)[keyof typeof DPOP_STATUS];

/** `auth_result` is two-valued; `failure_code` is null exactly when it is `success`. */
export const AUTH_RESULTS = ['success', 'failure'] as const;
export type AuthResult = (typeof AUTH_RESULTS)[number];
