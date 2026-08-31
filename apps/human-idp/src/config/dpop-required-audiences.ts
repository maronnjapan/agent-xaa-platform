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
