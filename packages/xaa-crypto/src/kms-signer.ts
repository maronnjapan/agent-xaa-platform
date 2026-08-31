import { KeyManagementServiceClient } from '@google-cloud/kms';
import { createPublicKey } from 'node:crypto';
import { derToRawEcdsaSignature } from './der.js';
import type { Es256Signer } from './jws.js';
import type { PublicJwkEs256 } from './keys.js';
import { sha256 } from './sha256.js';
import { XaaCryptoError } from './errors.js';

export function deriveKid(kidPrefix: string, keyVersionName: string): string {
  const match = keyVersionName.match(/\/cryptoKeyVersions\/(\d+)$/);
  if (!match) throw new XaaCryptoError('invalid_jwk');
  return `${kidPrefix}-${match[1]}`;
}

export function createKmsEs256Signer(options: {
  keyVersionName: string;
  kidPrefix: string;
  client?: KeyManagementServiceClient;
}): Es256Signer {
  const client = options.client ?? new KeyManagementServiceClient();
  return {
    kid: deriveKid(options.kidPrefix, options.keyVersionName),
    async sign(data) {
      const digest = await sha256(data);
      const [response] = await client.asymmetricSign({ name: options.keyVersionName, digest: { sha256: Buffer.from(digest) } });
      if (!response.signature) throw new XaaCryptoError('kms_signature_format');
      return derToRawEcdsaSignature(new Uint8Array(response.signature as Uint8Array), 32);
    },
  };
}

/** Fetches a KMS public key for publication to the shared JWKS. */
export async function fetchKmsPublicJwk(keyVersionName: string, client = new KeyManagementServiceClient()): Promise<PublicJwkEs256> {
  const [response] = await client.getPublicKey({ name: keyVersionName });
  if (!response.pem) throw new XaaCryptoError('invalid_jwk');
  const jwk = createPublicKey(response.pem).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new XaaCryptoError('invalid_jwk');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
