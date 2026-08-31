import { webcrypto } from 'node:crypto';

/** Test-only escape hatch. This module is intentionally absent from the root export. */
export async function exportPrivateJwk(key: CryptoKey): Promise<JsonWebKey> {
  if (key.type !== 'private') throw new TypeError('private key required');
  return webcrypto.subtle.exportKey('jwk', key);
}
