/**
 * docs 03 §7. The seven inputs a Risk Policy may look at, and nothing else.
 *
 * The source of each is fixed: the taxonomy owns what a capability inherently is
 * (`capability_risk`, `sensitive_resource`, `admin_permission`,
 * `personal_data_access`), and the AI may only describe what this particular work
 * does with it (`write_operation`, `external_communication`, `financial_operation`).
 * Where the two disagree the taxonomy wins — the AI is a proposer, not a decider.
 */
export const CHARACTERISTIC_KEYS = [
  'capability_risk', 'sensitive_resource', 'write_operation', 'admin_permission',
  'external_communication', 'financial_operation', 'personal_data_access',
] as const;

export type CharacteristicKey = (typeof CHARACTERISTIC_KEYS)[number];

export const CAPABILITY_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISK_LEVELS)[number];

export interface Characteristics {
  capability_risk: CapabilityRisk;
  sensitive_resource: boolean;
  write_operation: boolean;
  admin_permission: boolean;
  external_communication: boolean;
  financial_operation: boolean;
  personal_data_access: boolean;
}

/** Keys the taxonomy owns; an AI value for one of these is discarded. */
export const TAXONOMY_OWNED_KEYS = ['capability_risk', 'sensitive_resource', 'admin_permission', 'personal_data_access'] as const;
/** Keys the AI may contribute. */
export const AI_OWNED_KEYS = ['write_operation', 'external_communication', 'financial_operation'] as const;

export function maxCapabilityRisk(left: CapabilityRisk, right: CapabilityRisk): CapabilityRisk {
  const order = CAPABILITY_RISK_LEVELS.indexOf(left) >= CAPABILITY_RISK_LEVELS.indexOf(right);
  return order ? left : right;
}
