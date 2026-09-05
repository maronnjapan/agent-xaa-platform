import { CLIENT_ALLOWED_SCOPES, isOperationScope } from './scopes.js';

/**
 * REQ-02-014. The three Control Plane apps only accept DPoP-bound Access Tokens, so
 * a token request that targets one of them must carry a proof. This list is the only
 * place the three identifiers appear; `SCOPE_TO_AUDIENCE`'s value range is checked
 * against it at startup so the two cannot drift.
 */
export const DPOP_REQUIRED_AUDIENCES = ['authorization-platform', 'agent-provisioner', 'lifecycle-manager'] as const;

export type DpopRequiredAudience = (typeof DPOP_REQUIRED_AUDIENCES)[number];

export function requiresDpop(audience: unknown): boolean {
  const values = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
  return values.some((value) => (DPOP_REQUIRED_AUDIENCES as readonly unknown[]).includes(value));
}

/**
 * `DPOP_REQUIRED` is the blanket flag on top of the audience list above, and it is on
 * in every deployment. Whom it binds is decided here rather than at the call site.
 *
 * RULE-06 names three routes DPoP covers, and all three end at a Control Plane
 * audience. Agent OP -> Human IdP is not one of them: `agent-platform` is a
 * confidential back-channel client that redeems an authorization code and later
 * refreshes it, from a server, with no browser and no DPoP key (docs 05 §4.1). The
 * blanket flag applied to it anyway, so consenting to `offline_access` ended on the
 * Agent OP's "認可を完了できませんでした" page and no agent could ever refresh its
 * `subject_token`.
 *
 * The predicate is read off `CLIENT_ALLOWED_SCOPES` instead of naming the client, so
 * it cannot drift: a client that gains an operation scope gains a Control Plane
 * audience with it (`SCOPE_TO_AUDIENCE`), and the blanket requirement comes back the
 * moment it does. `agent-platform` holds `openid offline_access` and nothing else.
 */
export function blanketDpopApplies(clientId: string): boolean {
  return (CLIENT_ALLOWED_SCOPES[clientId] ?? []).some(isOperationScope);
}
