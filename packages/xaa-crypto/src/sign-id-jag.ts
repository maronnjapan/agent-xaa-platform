import { XaaCryptoError } from './errors.js';
import { signCompactJws, type Es256Signer } from './jws.js';

export async function signIdJag(claims: Record<string, unknown>, signer: Es256Signer): Promise<string> {
  const cnf = claims.cnf;
  if (!cnf || typeof cnf !== 'object' || typeof (cnf as Record<string, unknown>).jkt !== 'string' || !(cnf as Record<string, unknown>).jkt) {
    throw new XaaCryptoError('cnf_required');
  }
  for (const name of ['iss', 'sub', 'aud', 'exp', 'iat', 'jti']) if (claims[name] === undefined) throw new XaaCryptoError('invalid_signature');
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number' || claims.exp <= claims.iat) throw new XaaCryptoError('invalid_signature');
  return signCompactJws({
    header: { alg: 'ES256', typ: 'oauth-id-jag+jwt', kid: signer.kid },
    payload: claims,
    signer,
  });
}
