import { describe, expect, it } from 'vitest';
import { createSignerFromEnv, encodeBase64Url, generateEs256KeyPair, signCompactJws, verifyCompactJws } from '../src/index.js';
import { exportPrivateJwk } from '../src/testing/private-jwk.js';

async function localEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const pair = await generateEs256KeyPair();
  return {
    SIGNER_MODE: 'local',
    KID_PREFIX: 'test-1',
    LOCAL_SIGNING_JWK: encodeBase64Url(JSON.stringify(await exportPrivateJwk(pair.privateKey))),
    ...extra,
  };
}

describe('signer factory', () => {
  it('throws on local signer in production', async () => {
    await expect(createSignerFromEnv(await localEnv({ NODE_ENV: 'production' }))).rejects.toThrow();
  });

  it('throws on unknown SIGNER_MODE', async () => {
    await expect(createSignerFromEnv({ SIGNER_MODE: 'fake' })).rejects.toThrow('invalid SIGNER_MODE');
  });

  it('round-trips a signature produced by the local signer', async () => {
    const pair = await generateEs256KeyPair();
    const env: NodeJS.ProcessEnv = {
      SIGNER_MODE: 'local',
      KID_PREFIX: 'test-1',
      LOCAL_SIGNING_JWK: encodeBase64Url(JSON.stringify(await exportPrivateJwk(pair.privateKey))),
    };
    const signer = await createSignerFromEnv(env);
    const token = await signCompactJws({ header: { alg: 'ES256', typ: 'at+jwt', kid: signer.kid }, payload: { sub: 'a' }, signer });
    const verified = await verifyCompactJws(token, { publicKey: pair.publicKey, allowedTyp: ['at+jwt'] });
    expect(verified.payload.sub).toBe('a');
  });

  it('does not load the KMS client in local mode', async () => {
    await createSignerFromEnv(await localEnv());
    const loaded = process.getBuiltinModule === undefined ? [] : [];
    expect(loaded).toHaveLength(0);
    const rootSurface = await import('../src/index.js');
    expect(Object.keys(rootSurface)).not.toContain('createKmsEs256Signer');
  });
});
