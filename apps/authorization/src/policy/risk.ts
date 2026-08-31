import { maxIsolationLevel, type CapabilityDecision, type Characteristics, type IsolationLevel, type RiskPolicy } from '@xaa/contracts';

export interface RiskResult {
  riskScore: number;
  minIsolationLevel: IsolationLevel;
  addedConstraints: Record<string, unknown>;
  reasons: string[];
  denied: CapabilityDecision[];
}

/** Every key in `when` must match; there is no `or` and no `not`. */
function holds(policy: RiskPolicy, characteristics: Characteristics): boolean {
  return Object.entries(policy.when).every(([key, expected]) => characteristics[key as keyof Characteristics] === expected);
}

/**
 * RULE-12 / T-AUTHZ-18. The isolation level is decided here, from the characteristics
 * and the rule table — never from the AI's opinion and never from the score.
 *
 * A financial operation demands full isolation whatever the score says: there is no
 * downgrade path, because a low aggregate score would otherwise let a payment
 * approval run beside other agents.
 *
 * Pure and total: same input, same output, no clock, no I/O.
 */
export function evaluateRiskPolicy(
  characteristics: Characteristics,
  capabilities: string[],
  policies: RiskPolicy[],
): RiskResult {
  const reasons: string[] = [];
  const addedConstraints: Record<string, unknown> = {};
  const denied: CapabilityDecision[] = [];
  let isolationLevel: IsolationLevel = 'standard';
  let weight = 0;

  for (const policy of policies) {
    if (!holds(policy, characteristics)) continue;
    weight += policy.weight;
    isolationLevel = maxIsolationLevel(isolationLevel, policy.min_isolation_level);
    if (!reasons.includes(policy.reason_code)) reasons.push(policy.reason_code);
    if (policy.added_constraint) Object.assign(addedConstraints, policy.added_constraint);
    if (policy.deny === true) {
      for (const capability of capabilities) {
        denied.push({ capability_id: capability, decision: 'DENY', reason_code: 'risk_policy_denied', policy_id: policy.policy_id });
      }
    }
  }

  return {
    riskScore: Math.min(100, Math.max(0, Math.round(weight))),
    minIsolationLevel: isolationLevel,
    addedConstraints,
    reasons,
    denied,
  };
}
