import { importPublicJwk } from './keys.js';
import { XaaCryptoError } from './errors.js';

export interface JwksCache {
  getKey(kid: string): Promise<CryptoKey>;
  invalidate(): void;
}

export function createJwksCache(options: {
  url: string;
  ttlSeconds?: number;
  minRefetchIntervalSeconds?: number;
  allowedKidPrefixes?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}): JwksCache {
  const ttl = options.ttlSeconds ?? 300;
  const minimum = options.minRefetchIntervalSeconds ?? 10;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  let keys = new Map<string, CryptoKey>();
  let fetchedAt: number | undefined;
  let lastUnknownKidRefetchAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(options.url, { redirect: 'error' });
      if (!response.ok) throw new XaaCryptoError('invalid_jwk');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !Array.isArray((body as { keys?: unknown }).keys)) throw new XaaCryptoError('invalid_jwk');
      const bodyKeys = (body as { keys: unknown[] }).keys;
      const next = new Map<string, CryptoKey>();
      for (const jwk of bodyKeys) {
        if (!jwk || typeof jwk !== 'object' || typeof (jwk as Record<string, unknown>).kid !== 'string') continue;
        const kid = (jwk as Record<string, unknown>).kid as string;
        if (options.allowedKidPrefixes && !options.allowedKidPrefixes.some((prefix) => kid.startsWith(prefix))) continue;
        try { next.set(kid, await importPublicJwk(jwk)); } catch { /* Ignore unsupported keys in a mixed JWKS. */ }
      }
      keys = next;
      fetchedAt = now();
    })().finally(() => { pending = undefined; });
    return pending;
  }

  return {
    async getKey(kid) {
      const current = now();
      if (fetchedAt === undefined || current - fetchedAt >= ttl * 1000) await refresh();
      let key = keys.get(kid);
      const unknownAt = now();
      if (!key && unknownAt - lastUnknownKidRefetchAt >= minimum * 1000) {
        lastUnknownKidRefetchAt = unknownAt;
        await refresh();
        key = keys.get(kid);
      }
      if (!key) throw new XaaCryptoError('invalid_jwk');
      return key;
    },
    invalidate() {
      fetchedAt = undefined;
      lastUnknownKidRefetchAt = Number.NEGATIVE_INFINITY;
      keys.clear();
    },
  };
}
