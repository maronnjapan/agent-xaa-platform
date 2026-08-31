import { webcrypto } from 'node:crypto';
import { XaaCryptoError } from './errors.js';

export interface PublicJwkEs256 {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg?: 'ES256';
  use?: 'sig';
  kid?: string;
}

export interface Es256KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: PublicJwkEs256;
}

export async function generateEs256KeyPair(): Promise<Es256KeyPair> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk: await toPublicJwk(pair.publicKey),
  };
}

function assertPublicJwk(jwk: unknown): asserts jwk is PublicJwkEs256 {
  if (!jwk || typeof jwk !== 'object') throw new XaaCryptoError('invalid_jwk');
  const value = jwk as Record<string, unknown>;
  if (value.kty !== 'EC' || value.crv !== 'P-256' || typeof value.x !== 'string' || typeof value.y !== 'string' || 'd' in value) {
    throw new XaaCryptoError('invalid_jwk');
  }
}

export async function importPublicJwk(jwk: unknown): Promise<CryptoKey> {
  assertPublicJwk(jwk);
  try {
    return await webcrypto.subtle.importKey(
      'jwk',
      jwk as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
  } catch {
    throw new XaaCryptoError('invalid_jwk');
  }
}

export async function importPrivateJwk(jwk: unknown): Promise<CryptoKey> {
  if (!jwk || typeof jwk !== 'object') throw new XaaCryptoError('invalid_jwk');
  const value = jwk as Record<string, unknown>;
  if (value.kty !== 'EC' || value.crv !== 'P-256' || typeof value.x !== 'string' || typeof value.y !== 'string' || typeof value.d !== 'string') {
    throw new XaaCryptoError('invalid_jwk');
  }
  try {
    return await webcrypto.subtle.importKey(
      'jwk',
      value as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new XaaCryptoError('invalid_jwk');
  }
}

export async function toPublicJwk(key: CryptoKey): Promise<PublicJwkEs256> {
  if (key.type !== 'public') throw new XaaCryptoError('invalid_jwk');
  const jwk = await webcrypto.subtle.exportKey('jwk', key);
  assertPublicJwk(jwk);
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
