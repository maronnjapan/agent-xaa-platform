export const SCORE_FACTORS = [
  'protocol_violation', 'authorization_violation', 'authorization_ai_anomaly',
  'behavior_deviation', 'request_rate', 'resource_sensitivity', 'cross_agent_activity',
  'dpop_failure', 'delegation_mismatch', 'signing_key_misuse',
  'privilege_escalation_attempt', 'agent_expiration_violation', 'isolation_boundary_violation',
] as const;

export type ScoreFactor = (typeof SCORE_FACTORS)[number];

/**
 * Two findings that are critical on their own.
 *
 * A mismatched delegation means an agent acted for someone who did not delegate to it; a
 * misused signing key means a token was signed by something that is not the OP. Neither
 * is a matter of degree, so neither is combined with anything else — and the list is
 * kept here, in code, so lowering the numbers in scoring.json cannot soften them.
 */
export const CRITICAL_SINGLETON_FACTORS: readonly ScoreFactor[] = ['delegation_mismatch', 'signing_key_misuse'];

/**
 * Which score factor a contributing code belongs to.
 *
 * A code that maps to nothing is counted rather than ignored: an unmapped code is a rule
 * whose severity nobody decided, and it should show up in a counter rather than silently
 * scoring zero.
 */
export function factorFor(code: string): ScoreFactor | null {
  if (code.startsWith('token.')) return 'request_rate';
  if (code.startsWith('authorization_ai.')) return 'authorization_ai_anomaly';
  if (code.startsWith('authorization.')) return 'authorization_violation';
  if (code.startsWith('tool.')) return 'privilege_escalation_attempt';
  if (code.startsWith('lifetime.')) return 'agent_expiration_violation';
  if (code.startsWith('isolation.human_subject_mismatch')) return 'delegation_mismatch';
  if (code.startsWith('isolation.cross_agent_access')) return 'cross_agent_activity';
  if (code.startsWith('isolation.')) return 'isolation_boundary_violation';

  // Bare protocol-validation codes, as the Control Plane and the OP emit them.
  if (code === 'human_subject_mismatch' || code === 'delegation_mismatch') return 'delegation_mismatch';
  if (code === 'invalid_signature' || code === 'signing_key_misuse') return 'signing_key_misuse';
  if (code === 'invalid_dpop_proof' || code === 'replayed_dpop_proof' || code === 'dpop_key_binding_mismatch') return 'dpop_failure';
  if (code === 'unauthorized_tool' || code === 'xaa_config_out_of_range') return 'privilege_escalation_attempt';
  if (code === 'expired_agent' || code === 'expired_idp_connection' || code === 'expired_bridge_connection') return 'agent_expiration_violation';
  if (code === 'audience_mismatch' || code === 'resource_mismatch' || code === 'invalid_scope') return 'authorization_violation';
  if (code === 'behavior_deviation') return 'behavior_deviation';
  if (code === 'expired_token' || code === 'unknown_issuer' || code === 'invalid_client'
    || code === 'invalid_id_jag' || code === 'code_already_used' || code === 'refresh_token_reuse') return 'protocol_violation';
  if (code === 'forbidden_bridge_caller' || code === 'invalid_bridge_binding' || code === 'bridge_scope_violation') return 'authorization_violation';
  return null;
}
