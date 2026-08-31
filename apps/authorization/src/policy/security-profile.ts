import { compile, type IsolationLevel, type SecurityProfile } from '@xaa/contracts';
import type { RiskResult } from './risk.js';

export const securityProfileSchema = {
  $id: 'security-profile',
  type: 'object',
  additionalProperties: false,
  required: ['risk_score', 'isolation_level', 'reasons'],
  properties: {
    risk_score: { type: 'integer', minimum: 0, maximum: 100 },
    isolation_level: { enum: ['standard', 'full_isolation'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const;

const assertProfile: (value: unknown) => asserts value is SecurityProfile = compile<SecurityProfile>(securityProfileSchema);

/**
 * RULE-30. Three fields, and `isolation_level` has exactly two possible values —
 * there is no "partial" and no way to express one, at the type level or in the
 * schema.
 *
 * `reasons` holds reason codes only. A sentence explaining the score would be a
 * second, unreviewable vocabulary.
 */
export function buildSecurityProfile(risk: RiskResult): SecurityProfile {
  const profile: SecurityProfile = {
    risk_score: risk.riskScore,
    isolation_level: risk.minIsolationLevel satisfies IsolationLevel,
    reasons: [...risk.reasons],
  };
  assertProfile(profile);
  return profile;
}
