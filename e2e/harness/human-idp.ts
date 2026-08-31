import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import createHumanIdp from '@xaa/human-idp/app';
import { createHumanIdpStores } from '@xaa/human-idp/src/store/provider-stores';
import type { HumanIdpEnv } from '@xaa/human-idp/src/env';
import type { ProviderStores } from '@xaa/human-idp/src/oidc/store';
import type { SigningKeyProvider } from '@maronn-openid-connect/core';
import { webcrypto } from 'node:crypto';
import type { Fetcher } from './oauth-flow.js';

export const HUMAN_IDP_ISSUER = 'https://human-idp.test';
export const AUTOMATION_REDIRECT_URI = 'https://automation-app.test/callback';
export const AGENT_OP_CALLBACK_URI = 'https://agent-op-callback.test/xaa/callback';

export const humanIdpEnv: HumanIdpEnv = {
  port: 8080,
  issuer: HUMAN_IDP_ISSUER,
  issuerProfile: 'direct',
  jwksBucket: 'xaa-jwks',
  jwksPublicBaseUrl: 'https://storage.test/xaa-jwks',
  keyBucket: 'xaa-keys',
  kmsSsoKeyName: 'projects/p/locations/l/keyRings/sso-signing/cryptoKeys/sso',
  signerMode: 'local',
  storeMode: 'emulator',
  firestoreDatabase: 'xaa',
  dpopRequired: false,
  clientSecretAutomationApp: 'automation-secret',
  clientSecretAgentPlatform: 'agent-platform-secret',
  automationAppRedirectUri: AUTOMATION_REDIRECT_URI,
  agentOpCallbackUri: AGENT_OP_CALLBACK_URI,
  accessTokenExpiresIn: 3600,
};

let cachedProvider: SigningKeyProvider | undefined;

/** One RSA key for the whole suite: generating 2048-bit keys per test is slow. */
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

/** The SSO public JWK, so Agent OP can verify subject tokens this IdP issued. */
export async function idpPublicJwk(): Promise<JsonWebKey> {
  return (await (await testSigningKeyProvider()).getSigningKey()).publicJwk as JsonWebKey;
}

export interface HumanIdpHarness {
  fetch: Fetcher;
  stores: ProviderStores;
  jtiStore: JtiStore;
  env: HumanIdpEnv;
}

/**
 * One Human IdP in this process, reached with `app.fetch` (DEC-APP-07). No socket,
 * no second process.
 */
export async function startHumanIdp(overrides: Partial<HumanIdpEnv> = {}, auditLines?: string[]): Promise<HumanIdpHarness> {
  const env = { ...humanIdpEnv, ...overrides };
  // Audit lines are captured rather than printed unless a test asks for them, so a
  // suite run stays readable.
  const sink = auditLines ?? [];
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'human-idp');
  const { stores } = createHumanIdpStores(documents);
  const jtiStore = new InMemoryJtiStore();
  const app = createHumanIdp({
    env, stores, jtiStore, signingKeyProvider: await testSigningKeyProvider(),
    writeAuditLine: (line: string) => { sink.push(line); },
  });
  return {
    env,
    stores,
    jtiStore,
    fetch: async (path, init) => app.fetch(new Request(new URL(path, env.issuer), init)),
  };
}
