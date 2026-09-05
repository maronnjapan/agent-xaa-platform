/**
 * REQ-03-003. Every route the Control Plane may call, declared once.
 *
 * There is deliberately no GET route besides /livez: Automation App must not be
 * able to read the Capability Taxonomy, the Tool Catalog or the resource list from
 * here, because holding that list is what would let it start deciding permissions.
 *
 * The permission console is a separate table below, behind a separate guard.
 */
export const ROUTES = [
  { method: 'GET', path: '/livez', scope: null },
  { method: 'POST', path: '/v1/authorization/decisions', scope: 'workdef:submit' },
  { method: 'POST', path: '/api/work-requests', scope: 'workdef:submit' },
  { method: 'POST', path: '/internal/events/human-permission-changed', scope: null },
] as const;

/**
 * The permission console (docs 03 §2), which does have GET routes and is why the two
 * tables are separate.
 *
 * None of these is reachable with a Human Access Token, whatever its scope: they take
 * a Google-signed OIDC token for an account listed in `ADMIN_PRINCIPALS`, and the
 * Automation App's service account is not one. That, and not the absence of a GET, is
 * what keeps RULE-07 true here.
 */
export const ADMIN_ROUTES = [
  { method: 'GET', path: '/admin' },
  { method: 'GET', path: '/admin/permissions' },
  { method: 'GET', path: '/admin/permissions/new' },
  { method: 'GET', path: '/admin/permissions/:capability_id' },
  { method: 'POST', path: '/admin/permissions' },
  { method: 'POST', path: '/admin/permissions/:capability_id' },
  { method: 'POST', path: '/admin/permissions/:capability_id/delete' },
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
