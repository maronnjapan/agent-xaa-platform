import { randomBytes } from 'node:crypto';
import { encodeBase64Url, sha256Base64Url } from '@xaa/crypto';

export interface Pkce { verifier: string; challenge: string }

/**
 * S256 only.
 *
 * `plain` is still in RFC 7636 and still worthless: it puts the verifier in the
 * authorization request, which is the message PKCE exists to protect. There is no
 * branch for it here, so no deployment can select it.
 */
export async function createPkce(): Promise<Pkce> {
  const verifier = encodeBase64Url(new Uint8Array(randomBytes(48)));
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

export function newState(): string {
  return encodeBase64Url(new Uint8Array(randomBytes(32)));
}
