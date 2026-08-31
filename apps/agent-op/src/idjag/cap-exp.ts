import { IdJagError } from '@maronn-openid-connect/experimental/id-jag';

export const LIFETIME_EXHAUSTED = 'The agent lifetime does not allow issuing a grant';

/**
 * REQ-05-078 / REQ-07-017. A grant never outlives the agent that asked for it:
 * exp = min(iat + lifetime, agent expires_at). If that lands at or before now the
 * grant is refused instead of being issued already expired (DEC-ID-09).
 *
 * Called after attachCnf and before signIdJag; nothing rewrites `exp` after signing.
 */
export function capExp(claims: Record<string, unknown>, expiresAt: Date, now: Date, lifetimeSeconds: number): Record<string, unknown> {
  const iat = claims.iat;
  if (typeof iat !== 'number') throw new Error('iat is required before capping exp');
  const exp = Math.min(iat + lifetimeSeconds, Math.floor(expiresAt.getTime() / 1000));
  if (exp <= Math.floor(now.getTime() / 1000)) throw new IdJagError('invalid_grant', LIFETIME_EXHAUSTED);
  return { ...claims, exp };
}
