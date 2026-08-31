import { InMemoryJtiStore } from '@xaa/crypto';
import { createLogger } from '@xaa/logging';
import type { RedeemStep } from '@xaa/resource-guard';
import createApp from '../src/app.js';
import type { ResourceAsEnv } from '../src/config/env.js';
import { generateLocalSigningJwk, localSigningKey } from '../src/keys/self-bootstrap.js';

export const AS_ISSUER = 'https://resource-docs-as.test';

export const asEnv: ResourceAsEnv = {
  port: 8080, issuer: AS_ISSUER,
  trustedIdpIssuer: 'https://human-idp.test',
  trustedIdpJwksUri: 'https://storage.test/xaa-jwks/jwks.json',
  accessTokenExpiresIn: 300,
  registeredScopes: ['docs.read', 'docs.write'],
  signingKeyBucket: 'xaa-keys', signingKeyObject: 'signing/current.json',
  signingKeyKmsKey: 'projects/p/locations/l/keyRings/resource-as-signing/cryptoKeys/docs',
  jwksBucket: 'xaa-jwks', jwksKeyPrefix: 'docs-as',
  signerMode: 'local', storeMode: 'emulator',
  resourceUri: 'https://resource-docs-api.test', asKind: 'docs',
};

export async function createTestAs(overrides: Partial<ResourceAsEnv> = {}, jwks: unknown = { keys: [] }) {
  const logs: string[] = [];
  const steps: RedeemStep[] = [];
  const signingKey = await localSigningKey(await generateLocalSigningJwk(), overrides.jwksKeyPrefix ?? asEnv.jwksKeyPrefix);
  const app = createApp({
    env: { ...asEnv, ...overrides },
    signingKey,
    jtiStore: new InMemoryJtiStore(),
    fetchImpl: (async () => Response.json(jwks)) as unknown as typeof fetch,
    logger: createLogger('resource-docs-as', 'native_resource_as', (line) => { logs.push(line); }),
    recordStep: (step) => steps.push(step),
  });
  return {
    logs, steps, signingKey,
    fetch: (path: string, init?: RequestInit) => app.fetch(new Request(new URL(path, AS_ISSUER), init)),
  };
}
