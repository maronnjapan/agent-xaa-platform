import { REASON_TO_VIOLATION, type CapabilityDecision, type SecurityProfile } from '@xaa/contracts';
import type { LogContext, Logger } from '@xaa/logging';

export interface PolicyDecisionSummary {
  decision_id: string;
  proposed_capabilities: string[];
  effective_capabilities: string[];
  security_profile: SecurityProfile;
  decisions: CapabilityDecision[];
}

/**
 * docs 09 §2. Two shapes of line, and the detection queries of DEC-SEC-01 read both:
 * one summary per decision, and one line per evaluated capability.
 *
 * The per-capability lines are what make a refusal countable. A summary alone would
 * force a query to unpack an array to answer "how often was this capability refused,
 * and under which policy".
 *
 * Nothing here carries free text. `violation_code` is derived from the stored reason
 * through `REASON_TO_VIOLATION` rather than written out again, so the two vocabularies
 * cannot drift apart (T-AUTHZ-22).
 */
export function logPolicyDecision(logger: Logger, context: LogContext, summary: PolicyDecisionSummary): void {
  logger.info('policy.decide', context, {
    decision_id: summary.decision_id,
    proposed_capabilities: summary.proposed_capabilities,
    effective_capabilities: summary.effective_capabilities,
    security_profile: { ...summary.security_profile },
    isolation_level: summary.security_profile.isolation_level,
    risk_score: summary.security_profile.risk_score,
    reasons: summary.security_profile.reasons,
  });

  for (const decision of summary.decisions) {
    logger.info('policy.capability_decision', context, {
      decision_id: summary.decision_id,
      capability_id: decision.capability_id,
      decision: decision.decision,
      reason_code: decision.reason_code,
      // Explicitly null on an ALLOW: an absent key would make "allowed" and "the
      // mapping was not applied" the same row to a query.
      violation_code: REASON_TO_VIOLATION[decision.reason_code],
      policy_id: decision.policy_id,
    });
  }
}
