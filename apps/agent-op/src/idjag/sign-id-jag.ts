import { signCompactJws, type Es256Signer } from '@xaa/crypto';

/**
 * The only place Agent OP produces a signature.
 *
 * `typ` and `alg` are not parameters: RULE-48 / REQ-10-007 require that the ID-JAG
 * signing key can never be used to mint anything else. The claims argument is
 * `Record<string, unknown>` so the caller can spread `buildIdJagClaims`' result and
 * add `cnf` without a cast (DEC-ID-08).
 */
export const ID_JAG_TYP = 'oauth-id-jag+jwt';

export async function signIdJag(claims: Record<string, unknown>, signer: Es256Signer): Promise<string> {
  const header = { alg: 'ES256', typ: ID_JAG_TYP, kid: signer.kid } as const;
  // Re-checked before the key is touched: a future edit that swaps the constant must
  // fail here rather than produce a token of another type signed by this key.
  if (header.typ !== ID_JAG_TYP) throw new Error('ID-JAG signing key must only sign oauth-id-jag+jwt');
  const cnf = claims.cnf as { jkt?: unknown } | undefined;
  if (!cnf || typeof cnf !== 'object' || typeof cnf.jkt !== 'string' || cnf.jkt.length === 0) {
    throw new Error('cnf.jkt is required on every ID-JAG');
  }
  return signCompactJws({ header, payload: claims, signer });
}
