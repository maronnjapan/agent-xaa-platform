import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws, type JwksCache } from '@xaa/crypto';
import { verifyHumanAccessToken, verifyIdJag } from '../src/verify/index.js';
import * as verifySurface from '../src/verify/index.js';

const ISSUER = 'https://human-idp.test';
const AUDIENCE = 'https://resource-docs-as.test';

async function fixture() {
  const pair = await generateEs256KeyPair();
  const signer = createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'idp-1' });
  const jwks: JwksCache = { getKey: async () => pair.publicKey, invalidate() {} };
  const now = Math.floor(Date.now() / 1000);
  const sign = (typ: string, extra: Record<string, unknown> = {}) => signCompactJws({
    header: { alg: 'ES256', typ, kid: 'idp-1' },
    payload: { iss: ISSUER, sub: 'user-1', aud: AUDIENCE, exp: now + 300, iat: now, resource: 'https://api.test', ...extra },
    signer,
  });
  return { jwks, sign };
}

describe('typ-separated verification', () => {
  it('verifyIdJag rejects a plain ID Token with typ=JWT', async () => {
    const { jwks, sign } = await fixture();
    await expect(verifyIdJag(await sign('JWT'), { issuer: ISSUER, jwks, audience: AUDIENCE, resource: 'https://api.test' }))
      .rejects.toThrow('token verification failed');
  });

  it('verifyHumanAccessToken rejects an ID-JAG', async () => {
    const { jwks, sign } = await fixture();
    await expect(verifyHumanAccessToken(await sign('oauth-id-jag+jwt'), { issuer: ISSUER, jwks, audience: AUDIENCE }))
      .rejects.toThrow('token verification failed');
  });

  it('accepts each token at its own verifier', async () => {
    const { jwks, sign } = await fixture();
    await expect(verifyHumanAccessToken(await sign('at+jwt'), { issuer: ISSUER, jwks, audience: AUDIENCE })).resolves.toBeDefined();
    await expect(verifyIdJag(await sign('oauth-id-jag+jwt'), { issuer: ISSUER, jwks, audience: AUDIENCE, resource: 'https://api.test' })).resolves.toBeDefined();
  });

  it('index.ts does not export verifyJwt', () => {
    expect(Object.keys(verifySurface).sort()).toEqual(['verifyGoogleServiceIdentity', 'verifyHumanAccessToken', 'verifyIdJag']);
  });

  it('no route or middleware calls a raw verifyJwt', () => {
    const repoRoot = new URL('../../../', import.meta.url).pathname;
    expect(() => execFileSync('bash', ['scripts/check-no-raw-verify-jwt.sh'], { cwd: repoRoot })).not.toThrow();
  });
});
