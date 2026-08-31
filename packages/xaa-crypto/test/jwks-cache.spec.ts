import { describe, expect, it } from 'vitest';
import { createJwksCache, generateEs256KeyPair, XaaCryptoError } from '../src/index.js';

async function jwksBody() {
  const idp = await generateEs256KeyPair();
  const op = await generateEs256KeyPair();
  return { keys: [{ ...idp.publicJwk, kid: 'idp-1' }, { ...op.publicJwk, kid: 'op-shared-1' }] };
}

function counter(body: unknown) {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return Response.json(body); }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('shared JWKS cache', () => {
  it('refetches once on unknown kid', async () => {
    const { fetchImpl, calls } = counter(await jwksBody());
    const cache = createJwksCache({ url: 'https://jwks.test/jwks.json', fetchImpl });
    await expect(cache.getKey('idp-9')).rejects.toBeInstanceOf(XaaCryptoError);
    expect(calls()).toBe(2);
  });

  it('honours minRefetchIntervalSeconds across repeated unknown kids', async () => {
    const { fetchImpl, calls } = counter(await jwksBody());
    let now = 0;
    const cache = createJwksCache({ url: 'https://jwks.test/jwks.json', fetchImpl, now: () => now });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await cache.getKey('idp-9').catch(() => undefined);
    }
    expect(calls()).toBeLessThanOrEqual(2);
    now = 1;
  });

  it('drops kids outside allowedKidPrefixes', async () => {
    const { fetchImpl } = counter(await jwksBody());
    const cache = createJwksCache({ url: 'https://jwks.test/jwks.json', fetchImpl, allowedKidPrefixes: ['idp-'] });
    await expect(cache.getKey('idp-1')).resolves.toBeDefined();
    await expect(cache.getKey('op-shared-1')).rejects.toBeInstanceOf(XaaCryptoError);
  });

  it('refetches after the ttl and not before', async () => {
    const { fetchImpl, calls } = counter(await jwksBody());
    let now = 0;
    const cache = createJwksCache({ url: 'https://jwks.test/jwks.json', fetchImpl, ttlSeconds: 300, now: () => now });
    await cache.getKey('idp-1');
    expect(calls()).toBe(1);
    now = 299_000;
    await cache.getKey('idp-1');
    expect(calls()).toBe(1);
    now = 300_000;
    await cache.getKey('idp-1');
    expect(calls()).toBe(2);
  });
});
