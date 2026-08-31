import { describe, expect, it } from 'vitest';
import { createSharedJwks, type JwkSet } from '../src/keys/shared-jwks.js';

function source(keys: JwkSet['keys'], failAfter = Number.POSITIVE_INFINITY) {
  let calls = 0;
  return {
    calls: () => calls,
    read: async (): Promise<JwkSet> => {
      calls += 1;
      if (calls > failAfter) throw new Error('bucket unavailable');
      return { keys };
    },
  };
}

const keys = [
  { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 'idp-1', alg: 'ES256' },
  { kty: 'EC', crv: 'P-256', x: 'c', y: 'd', kid: 'op-shared-1', alg: 'ES256' },
  { kty: 'EC', crv: 'P-256', x: 'e', y: 'f', kid: 'idjag-abcdefghijkl-1', alg: 'ES256' },
] as JwkSet['keys'];

describe('shared JWKS cache', () => {
  it('refetches immediately on unknown kid', async () => {
    let now = 1_000_000;
    const backing = source(keys);
    const jwks = createSharedJwks(backing, () => now);
    expect(await jwks.resolveKeyByKid('idp-1')).toBeDefined();
    expect(backing.calls()).toBe(1);
    now += 2_000;
    expect(await jwks.resolveKeyByKid('idp-unknown')).toBeNull();
    expect(backing.calls()).toBe(2);
  });

  it('subjectTokenJwks contains only idp-prefixed kids', async () => {
    const jwks = createSharedJwks(source(keys));
    expect((await jwks.subjectTokenJwks()).keys.map((key) => key.kid)).toEqual(['idp-1']);
  });

  it('coalesces concurrent refetches into one read', async () => {
    const backing = source(keys);
    const jwks = createSharedJwks(backing);
    await Promise.all(Array.from({ length: 8 }, () => jwks.loadSharedJwks()));
    expect(backing.calls()).toBe(1);
  });

  it('throws instead of serving expired cache when fetch fails', async () => {
    let now = 1_000_000;
    const backing = source(keys, 1);
    const jwks = createSharedJwks(backing, () => now);
    await jwks.loadSharedJwks();
    now += 300_001;
    await expect(jwks.loadSharedJwks()).rejects.toThrow('bucket unavailable');
  });

  it('serves the cache inside the 300 second window', async () => {
    let now = 1_000_000;
    const backing = source(keys);
    const jwks = createSharedJwks(backing, () => now);
    await jwks.loadSharedJwks();
    now += 299_000;
    await jwks.loadSharedJwks();
    expect(backing.calls()).toBe(1);
    now += 2_000;
    await jwks.loadSharedJwks();
    expect(backing.calls()).toBe(2);
  });
});
