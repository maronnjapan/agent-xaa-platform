import { createCachedSigningKeyProvider, type SigningKey, type SigningKeyProvider } from '@maronn-openid-connect/core';
import type { BootstrapResult } from './self-bootstrap.js';

/**
 * Wraps the bootstrapped key in the shape core expects. Both getSigningKey and
 * getSigningKeys are implemented so JWKS and discovery advertise the same set.
 */
export function createHumanIdpSigningKeyProvider(bootstrap: () => Promise<BootstrapResult>): SigningKeyProvider {
  const base: SigningKeyProvider = {
    async getSigningKey(): Promise<SigningKey> {
      const result = await bootstrap();
      return { privateKey: result.privateKey, publicJwk: result.publicJwk, keyId: result.kid };
    },
    async getSigningKeys(): Promise<SigningKey[]> {
      const result = await bootstrap();
      return [{ privateKey: result.privateKey, publicJwk: result.publicJwk, keyId: result.kid }];
    },
  };
  return createCachedSigningKeyProvider(base, 300_000);
}
