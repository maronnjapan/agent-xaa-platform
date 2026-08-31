/**
 * docs 03 §6. Two closed vocabularies, and one table joining them.
 *
 * `REASON_CODES` is what a stored per-capability decision may say; `VIOLATION_CODES`
 * is what a log line and an Activity Event may say. Neither ever carries free text,
 * and no third name is invented anywhere: the mapping below is the only bridge.
 */
export const REASON_CODES = [
  'not_in_human_permission', 'not_delegatable', 'org_policy_denied', 'risk_policy_denied', 'allowed',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const VIOLATION_CODES = [
  'human_permission_exceeded', 'delegatable_permission_violation',
  'organization_policy_violation', 'risk_policy_violation',
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export const REASON_TO_VIOLATION: Readonly<Record<ReasonCode, ViolationCode | null>> = {
  not_in_human_permission: 'human_permission_exceeded',
  not_delegatable: 'delegatable_permission_violation',
  org_policy_denied: 'organization_policy_violation',
  risk_policy_denied: 'risk_policy_violation',
  allowed: null,
};

export function assertReasonCode(value: string): asserts value is ReasonCode {
  if (!(REASON_CODES as readonly string[]).includes(value)) throw new Error(`invalid reason_code: ${value}`);
}
