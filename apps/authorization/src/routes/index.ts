/**
 * REQ-03-003. Every route this app exposes, declared once.
 *
 * There is deliberately no GET route besides /livez: Automation App must not be
 * able to read the Capability Taxonomy, the Tool Catalog or the resource list from
 * here, because holding that list is what would let it start deciding permissions.
 */
export const ROUTES = [
  { method: 'GET', path: '/livez', scope: null },
  { method: 'POST', path: '/v1/authorization/decisions', scope: 'workdef:submit' },
  { method: 'POST', path: '/api/work-requests', scope: 'workdef:submit' },
  { method: 'POST', path: '/internal/events/human-permission-changed', scope: null },
] as const;

export const DECISION_RESPONSE_KEYS = ['decision_id', 'status', 'effective_capabilities', 'security_profile', 'denied'] as const;

export const authorizationDecisionResponseSchema = {
  $id: 'authorization-decision-response',
  type: 'object',
  additionalProperties: false,
  required: [...DECISION_RESPONSE_KEYS],
  properties: {
    decision_id: { type: 'string', pattern: '^dec_[0-9a-f-]{36}$' },
    status: { enum: ['decided', 'no_capability_inferred'] },
    effective_capabilities: { type: 'array', items: { type: 'string' } },
    security_profile: {
      type: 'object',
      additionalProperties: false,
      required: ['risk_score', 'isolation_level', 'reasons'],
      properties: {
        risk_score: { type: 'integer', minimum: 0, maximum: 100 },
        isolation_level: { enum: ['standard', 'full_isolation'] },
        reasons: { type: 'array', items: { type: 'string' } },
      },
    },
    denied: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['capability_id', 'decision', 'reason_code', 'policy_id'],
        properties: {
          capability_id: { type: 'string' },
          decision: { const: 'DENY' },
          reason_code: { type: 'string' },
          policy_id: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;
