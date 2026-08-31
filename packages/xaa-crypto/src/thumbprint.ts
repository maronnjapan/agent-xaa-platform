import { sha256Base64Url } from './sha256.js';
import { XaaCryptoError } from './errors.js';
import type { PublicJwkEs256 } from './keys.js';

export async function jwkThumbprint(jwk: PublicJwkEs256): Promise<string> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new XaaCryptoError('invalid_jwk');
  }
  return sha256Base64Url(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}
