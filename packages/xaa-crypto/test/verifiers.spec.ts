import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  createLocalEs256Signer,
  encodeBase64Url,
  generateEs256KeyPair,
  signCompactJws,
  verifyHumanAccessToken,
  verifyHumanIdToken,
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

async function rs256Token(typ: 'JWT' | 'at+jwt'): Promise<{ token: string; publicKey: CryptoKey }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ, kid: 'idp-rsa-1' }));
  const encodedPayload = encodeBase64Url(JSON.stringify({
    iss: ISSUER, sub: 'user-1', aud: AUDIENCE, exp: now + 300, iat: now, jti: 'rsa-j1',
  }));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signingInput),
  );
  return { token: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`, publicKey: pair.publicKey };
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

  it('accepts RS256 Human Access Tokens and ID Tokens', async () => {
    const access = await rs256Token('at+jwt');
    const id = await rs256Token('JWT');
    const accessJwks: JwksCache = { getKey: async () => access.publicKey, invalidate() {} };
    const idJwks: JwksCache = { getKey: async () => id.publicKey, invalidate() {} };

    await expect(verifyHumanAccessToken(access.token, {
      issuer: ISSUER, jwks: accessJwks, audience: AUDIENCE,
    })).resolves.toMatchObject({ sub: 'user-1' });
    await expect(verifyHumanIdToken(id.token, {
      issuer: ISSUER, jwks: idJwks, audience: AUDIENCE,
    })).resolves.toMatchObject({ sub: 'user-1' });
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
