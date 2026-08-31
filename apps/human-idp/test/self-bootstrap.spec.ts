import { describe, expect, it } from 'vitest';
import { bootstrapSigningKey, deriveIdpKid, SSO_KEY_OBJECT, type Envelope, type ObjectStore } from '../src/keys/self-bootstrap.js';

function memoryStore(): ObjectStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async read(path) { return objects.get(path) ?? null; },
    async createIfAbsent(path, body) {
      if (objects.has(path)) throw Object.assign(new Error('precondition failed'), { code: 412 });
      objects.set(path, body);
    },
    async write(path, body) { objects.set(path, body); },
  };
}

const envelope: Envelope = {
  async encrypt(plaintext) { return Buffer.from(plaintext, 'utf8').toString('base64'); },
  async decrypt(ciphertext) { return Buffer.from(ciphertext, 'base64').toString('utf8'); },
};

describe('SSO signing key self-bootstrap', () => {
  it('idempotent under concurrent start', async () => {
    const store = memoryStore();
    const jwksStore = memoryStore();
    const results = await Promise.all(Array.from({ length: 10 }, () => bootstrapSigningKey({ store, jwksStore, envelope })));
    expect(new Set(results.map((result) => result.kid)).size).toBe(1);
    expect(store.objects.size).toBe(1);
    expect([...jwksStore.objects.keys()]).toEqual([`keys/${results[0]!.kid}.json`]);
  }, 30_000);

  it('decrypts existing key', async () => {
    const store = memoryStore();
    const jwksStore = memoryStore();
    const first = await bootstrapSigningKey({ store, jwksStore, envelope });
    const second = await bootstrapSigningKey({ store, jwksStore, envelope });
    expect(second.kid).toBe(first.kid);
    expect(second.privateKey.algorithm.name).toBe('RSASSA-PKCS1-v1_5');
  }, 30_000);

  it('publishes an RS256 public jwk whose kid starts with idp-', async () => {
    const store = memoryStore();
    const jwksStore = memoryStore();
    const result = await bootstrapSigningKey({ store, jwksStore, envelope });
    expect(result.kid.startsWith('idp-')).toBe(true);
    const published = JSON.parse([...jwksStore.objects.values()][0]!) as Record<string, unknown>;
    expect(published.kty).toBe('RSA');
    expect(published.alg).toBe('RS256');
    expect(published.kid).toBe(result.kid);
    expect(published).not.toHaveProperty('d');
  }, 30_000);

  it('stores the private key wrapped, never in the clear', async () => {
    const store = memoryStore();
    const record = JSON.parse(await (async () => {
      await bootstrapSigningKey({ store, jwksStore: memoryStore(), envelope });
      return store.objects.get(SSO_KEY_OBJECT)!;
    })()) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['alg', 'created_at', 'encrypted_private_jwk', 'kid', 'public_jwk']);
    expect(JSON.stringify(record.public_jwk)).not.toContain('"d"');
  }, 30_000);

  it('derives a deterministic kid from the public jwk', async () => {
    const jwk = { kty: 'RSA', n: 'abc', e: 'AQAB' };
    expect(await deriveIdpKid(jwk)).toBe(await deriveIdpKid({ ...jwk, kid: 'other' }));
    expect((await deriveIdpKid(jwk)).length).toBe('idp-'.length + 8);
  });
});
