import { describe, expect, it } from 'vitest';
import { ensureSigningKey, type Envelope, type ObjectStore } from '../src/keys/self-bootstrap.js';

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

/** Each resource has its own KMS key, so a namespaced envelope models the split. */
function envelope(keyName: string): Envelope {
  return {
    async encrypt(plaintext) { return Buffer.from(`${keyName}::${plaintext}`, 'utf8').toString('base64'); },
    async decrypt(ciphertext) {
      const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
      if (!decoded.startsWith(`${keyName}::`)) throw new Error('this key cannot decrypt that envelope');
      return decoded.slice(keyName.length + 2);
    },
  };
}

const OBJECT_PATH = 'signing/current.json';

describe('Resource AS signing key', () => {
  it('idempotent under concurrent start', async () => {
    const store = memoryStore();
    const jwksStore = memoryStore();
    const results = await Promise.all(Array.from({ length: 10 }, () => ensureSigningKey({
      store, jwksStore, envelope: envelope('docs'), objectPath: OBJECT_PATH, kidPrefix: 'docs-as',
    })));
    expect(new Set(results.map((result) => result.kid)).size).toBe(1);
    expect(store.objects.size).toBe(1);
  }, 60_000);

  it('decrypts an existing key instead of generating a second one', async () => {
    const store = memoryStore();
    const jwksStore = memoryStore();
    const options = { store, jwksStore, envelope: envelope('docs'), objectPath: OBJECT_PATH, kidPrefix: 'docs-as' };
    const first = await ensureSigningKey(options);
    const second = await ensureSigningKey(options);
    expect(second.kid).toBe(first.kid);
    expect(jwksStore.objects.size).toBe(1);
  }, 60_000);

  it('cannot decrypt the other resource\'s envelope', async () => {
    const store = memoryStore();
    const jwksStore = memoryStore();
    await ensureSigningKey({ store, jwksStore, envelope: envelope('docs'), objectPath: OBJECT_PATH, kidPrefix: 'docs-as' });
    await expect(ensureSigningKey({
      store, jwksStore, envelope: envelope('finance'), objectPath: OBJECT_PATH, kidPrefix: 'fin-as',
    })).rejects.toThrow('this key cannot decrypt that envelope');
  }, 60_000);

  it('publishes only its own key object and never jwks.json', async () => {
    const store = memoryStore();
    const jwksStore = memoryStore();
    const result = await ensureSigningKey({ store, jwksStore, envelope: envelope('docs'), objectPath: OBJECT_PATH, kidPrefix: 'docs-as' });
    expect([...jwksStore.objects.keys()]).toEqual([`keys/${result.kid}.json`]);
    const published = JSON.parse([...jwksStore.objects.values()][0]!) as Record<string, unknown>;
    expect(published.alg).toBe('RS256');
    expect(published.kid).toBe(result.kid);
    expect(published).not.toHaveProperty('d');
  }, 60_000);

  it('derives a stable kid with the resource prefix', async () => {
    const store = memoryStore();
    const result = await ensureSigningKey({
      store, jwksStore: memoryStore(), envelope: envelope('finance'), objectPath: OBJECT_PATH, kidPrefix: 'fin-as',
    });
    expect(result.kid).toMatch(/^fin-as-[a-z0-9]{8}$/);
  }, 60_000);
});
