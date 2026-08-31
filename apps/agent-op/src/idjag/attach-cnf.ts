import type { IdJagClaims } from '@maronn-openid-connect/experimental/id-jag';

/**
 * REQ-05-077 / REQ-05-079. IdJagClaims has no `cnf` member, so the claims are spread
 * into a plain record and the confirmation is added there. signIdJag takes
 * `Record<string, unknown>` precisely so this needs no cast (DEC-ID-08).
 *
 * There is no branch that omits `cnf`. The DPoP middleware already makes a proof
 * mandatory on /xaa/token, so the throw below is defence in depth and should never
 * fire on the normal path.
 */
export function attachCnf(claims: IdJagClaims, jkt: string): Record<string, unknown> {
  if (!jkt) throw new Error('cnf.jkt is required on every ID-JAG');
  return { ...claims, cnf: { jkt } };
}
