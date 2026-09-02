import { describe, expect, it, vi } from 'vitest';
import { createSignerFromEnv, encodeBase64Url, generateEs256KeyPair, signCompactJws, verifyCompactJws } from '../src/index.js';
import { exportPrivateJwk } from '../src/testing/private-jwk.js';

// The record of dynamic imports the local branch must leave empty. The factory runs
// once, the first time anything pulls in the KMS SDK.
const { kmsModuleLoads } = vi.hoisted(() => ({ kmsModuleLoads: [] as string[] }));
vi.mock('@google-cloud/kms', () => {
  kmsModuleLoads.push('@google-cloud/kms');
  return { KeyManagementServiceClient: class { } };
});

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
    expect(kmsModuleLoads).toEqual([]);
    const rootSurface = await import('../src/index.js');
    expect(Object.keys(rootSurface)).not.toContain('createKmsEs256Signer');
    // The probe is not vacuous: the kms branch does reach the SDK.
    await createSignerFromEnv({
      SIGNER_MODE: 'kms', KID_PREFIX: 'op-shared',
      KMS_KEY_VERSION: 'projects/p/locations/l/keyRings/k/cryptoKeys/c/cryptoKeyVersions/1',
    });
    expect(kmsModuleLoads).toEqual(['@google-cloud/kms']);
  });
});
