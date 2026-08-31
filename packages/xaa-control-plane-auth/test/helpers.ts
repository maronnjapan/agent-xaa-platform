import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws, type Es256KeyPair } from '@xaa/crypto';

export async function setupIssuer() {
  const pair = await generateEs256KeyPair();
  const fetchImpl: typeof fetch = async () => Response.json({ keys: [{ ...pair.publicJwk, kid: 'issuer-key' }] });
  return { pair, fetchImpl };
}

export async function accessToken(pair: Es256KeyPair, overrides: Record<string, unknown> = {}, typ = 'at+jwt'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ, kid: 'issuer-key' },
    payload: { iss: 'https://issuer.example', sub: 'user-123', aud: 'authorization-platform', scope: 'workdef:submit', exp: now + 300, iat: now, jti: 'at-jti', cnf: { jkt: 'thumb' }, ...overrides },
    signer: createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'issuer-key' }),
  });
}
