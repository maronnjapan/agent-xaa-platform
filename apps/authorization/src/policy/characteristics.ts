import {
  AI_OWNED_KEYS, CHARACTERISTIC_KEYS, maxCapabilityRisk, TAXONOMY_OWNED_KEYS,
  type Characteristics, type CapabilityRisk,
} from '@xaa/contracts';

export interface MergeResult {
  characteristics: Characteristics;
  /** One entry per AI value the taxonomy overrode. */
  overridden: string[];
}

/**
 * T-AUTHZ-15. Aggregates the taxonomy defaults of every proposed capability and
 * folds in what the AI observed about this particular work.
 *
 * Booleans combine with OR and `capability_risk` takes the maximum, because a set of
 * capabilities is at least as risky as its riskiest member. Where the taxonomy has an
 * opinion it wins and the AI's value is recorded as overridden — the AI describes,
 * it does not classify.
 *
 * Pure, and the result is a freshly built object of exactly the seven keys: nothing
 * from either input is spread through.
 */
export function mergeCharacteristics(
  taxonomyDefaults: Array<Partial<Characteristics>>,
  aiCharacteristics: Partial<Characteristics>,
): MergeResult {
  const merged: Characteristics = {
    capability_risk: 'low',
    sensitive_resource: false,
    write_operation: false,
    admin_permission: false,
    external_communication: false,
    financial_operation: false,
    personal_data_access: false,
  };

  const taxonomyStated = new Set<string>();
  for (const defaults of taxonomyDefaults) {
    for (const key of CHARACTERISTIC_KEYS) {
      const value = defaults[key];
      if (value === undefined) continue;
      taxonomyStated.add(key);
      if (key === 'capability_risk') merged.capability_risk = maxCapabilityRisk(merged.capability_risk, value as CapabilityRisk);
      else merged[key] = merged[key] as boolean || value as boolean;
    }
  }

  const overridden: string[] = [];
  for (const key of AI_OWNED_KEYS) {
    const value = aiCharacteristics[key];
    if (value === undefined) continue;
    if (taxonomyStated.has(key)) { overridden.push(key); continue; }
    merged[key] = merged[key] || value;
  }
  // A taxonomy-owned key is never taken from the AI, even if it never appeared in
  // any default: the AI has no standing to declare a capability sensitive or not.
  for (const key of TAXONOMY_OWNED_KEYS) {
    if (aiCharacteristics[key] !== undefined) overridden.push(key);
  }

  return { characteristics: merged, overridden };
}
