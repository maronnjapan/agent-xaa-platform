import { InMemoryJtiStore } from '@xaa/crypto';
import { webcrypto } from 'node:crypto';
import createApp from '../src/app.js';
import type { HumanIdpEnv } from '../src/env.js';
import { createJsonProviderStores, type JsonStoreBackend, type JsonStoreEntry, type ProviderStores } from '../src/oidc/store.js';
import type { SigningKeyProvider } from '@maronn-openid-connect/core';

export const testEnv: HumanIdpEnv = {
  port: 8080,
  issuer: 'https://human-idp.test',
  issuerProfile: 'direct',
  jwksBucket: 'xaa-jwks',
  jwksPublicBaseUrl: 'https://storage.test/xaa-jwks',
  keyBucket: 'xaa-keys',
  kmsSsoKeyName: 'projects/p/locations/l/keyRings/sso-signing/cryptoKeys/sso',
  signerMode: 'local',
  storeMode: 'emulator',
  firestoreDatabase: 'xaa',
  dpopRequired: true,
  clientSecretAutomationApp: 'automation-secret',
  clientSecretAgentPlatform: 'agent-platform-secret',
  automationAppRedirectUri: 'https://automation-app.test/callback',
  agentOpCallbackUri: 'https://agent-op-callback.test/xaa/callback',
  accessTokenExpiresIn: 3600,
};

/** In-memory JsonStoreBackend with the same semantics as the Firestore one. */
export function createMemoryBackend(now: () => number = () => Date.now()): JsonStoreBackend {
  const entries = new Map<string, { value: unknown; expiresAt: number | null }>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const entry = entries.get(key);
      if (!entry || (entry.expiresAt !== null && entry.expiresAt <= now())) return null;
      return entry.value as T;
    },
    async put<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      entries.set(key, { value, expiresAt: ttlSeconds === undefined ? null : now() + ttlSeconds * 1000 });
    },
    async delete(key: string): Promise<void> { entries.delete(key); },
    async list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>> {
      return [...entries].flatMap(([key, entry]) =>
        key.startsWith(prefix) && (entry.expiresAt === null || entry.expiresAt > now())
          ? [{ key, value: entry.value as T }] : []);
    },
  };
}

let cachedProvider: SigningKeyProvider | undefined;
export async function testSigningKeyProvider(): Promise<SigningKeyProvider> {
  if (cachedProvider) return cachedProvider;
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const key = { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid: 'idp-testkey', alg: 'RS256', use: 'sig' }, keyId: 'idp-testkey' };
  cachedProvider = { async getSigningKey() { return key; }, async getSigningKeys() { return [key]; } };
  return cachedProvider;
}

export interface TestApp {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stores: ProviderStores;
}

export async function createTestApp(overrides: Partial<HumanIdpEnv> = {}, writeAuditLine?: (line: string) => void): Promise<TestApp> {
  const env = { ...testEnv, ...overrides };
  const stores = createJsonProviderStores(createMemoryBackend());
  const app = createApp({ env, stores, jtiStore: new InMemoryJtiStore(), signingKeyProvider: await testSigningKeyProvider(), ...(writeAuditLine ? { writeAuditLine } : {}) });
  return {
    fetch: (path, init) => app.fetch(new Request(new URL(path, env.issuer), init)),
    stores,
  };
}

export function formBody(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

export function basicAuth(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}
