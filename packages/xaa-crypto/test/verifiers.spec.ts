import { describe, expect, it } from 'vitest';
import {
  createLocalEs256Signer,
  generateEs256KeyPair,
  signCompactJws,
  verifyHumanAccessToken,
  verifyIdJag,
  type JwksCache,
} from '../src/index.js';

const ISSUER = 'https://idp.test';
const AUDIENCE = 'https://resource.test';

async function fixture() {
  const pair = await generateEs256KeyPair();
  const signer = createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'idp-1' });
  const jwks: JwksCache = { getKey: async () => pair.publicKey, invalidate() {} };
  const now = Math.floor(Date.now() / 1000);
  const sign = (typ: string, extra: Record<string, unknown> = {}) => signCompactJws({
    header: { alg: 'ES256', typ, kid: 'idp-1' },
    payload: { iss: ISSUER, sub: 'user-1', aud: AUDIENCE, exp: now + 300, iat: now, jti: 'j1', ...extra },
    signer,
  });
  return { jwks, sign, now };
}

describe('typ-separated verifiers', () => {
  it('verifyIdJag rejects typ JWT id token', async () => {
    const { jwks, sign } = await fixture();
    await expect(verifyIdJag(await sign('JWT'), { issuer: ISSUER, jwks, audience: AUDIENCE, resource: 'https://api.test' }))
      .rejects.toThrow('token verification failed');
  });

  it('verifyHumanAccessToken rejects typ oauth-id-jag+jwt', async () => {
    const { jwks, sign } = await fixture();
    await expect(verifyHumanAccessToken(await sign('oauth-id-jag+jwt'), { issuer: ISSUER, jwks, audience: AUDIENCE }))
      .rejects.toThrow('token verification failed');
  });

  it('accepts a well-formed access token', async () => {
    const { jwks, sign } = await fixture();
    const payload = await verifyHumanAccessToken(await sign('at+jwt'), { issuer: ISSUER, jwks, audience: AUDIENCE });
    expect(payload.sub).toBe('user-1');
  });

  it('reports the same message for every failure reason', async () => {
    const { jwks, sign, now } = await fixture();
    const messages: string[] = [];
    for (const token of [
      await sign('at+jwt', { iss: 'https://evil.test' }),
      await sign('at+jwt', { exp: now - 3600 }),
      await sign('at+jwt', { aud: 'https://other.test' }),
    ]) {
      await verifyHumanAccessToken(token, { issuer: ISSUER, jwks, audience: AUDIENCE })
        .catch((error: Error) => messages.push(error.message));
    }
    expect(messages).toEqual(['token verification failed', 'token verification failed', 'token verification failed']);
  });

  it('does not re-export the internal helper', async () => {
    const surface = await import('../src/index.js');
    expect(Object.keys(surface)).not.toContain('verifyJwtInternal');
  });
});
