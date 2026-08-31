import { webcrypto } from 'node:crypto';
import { sha256Base64Url } from '@xaa/crypto';

export interface ObjectStore {
  read(path: string): Promise<string | null>;
  createIfAbsent(path: string, body: string): Promise<void>;
  write(path: string, body: string): Promise<void>;
}

export interface Envelope {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface SigningKeyMaterial {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string; alg: 'RS256'; use: 'sig' };
}

export function isPreconditionFailed(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return code === 412 || code === '412';
}

/**
 * 00b fixes the Resource AS signing key as RSA-2048/RS256: core's
 * `buildProviderMetadata` calls `assertHasRs256Key` unconditionally, so a key set
 * with only ES256 makes discovery throw.
 *
 * DEC-ID-17 / DEV-10: core's SigningKeyProvider needs a CryptoKey, so the key cannot
 * live in KMS. It is generated once, wrapped with this resource's own KMS key and
 * stored in a private bucket. The two Resource AS point at different CryptoKeys
 * (`resource-as-signing/docs` and `.../finance`), so the documents key cannot
 * decrypt the finance envelope — that is what stops one AS from minting the other's
 * tokens.
 *
 * `kid` comes from the public key's RFC 7638 thumbprint, so a restart keeps it.
 */
export async function ensureSigningKey(options: {
  store: ObjectStore;
  jwksStore: ObjectStore;
  envelope: Envelope;
  objectPath: string;
  kidPrefix: string;
}): Promise<SigningKeyMaterial> {
  const existing = await options.store.read(options.objectPath);
  if (existing) return importRecord(JSON.parse(existing) as StoredKey, options.envelope);

  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const kid = await deriveKid(options.kidPrefix, publicJwk);
  const record: StoredKey = {
    kid, alg: 'RS256',
    encrypted_private_jwk: await options.envelope.encrypt(JSON.stringify(privateJwk)),
    public_jwk: { kty: 'RSA', n: publicJwk.n!, e: publicJwk.e!, kid, alg: 'RS256', use: 'sig' },
    created_at: new Date().toISOString(),
  };

  try {
    await options.store.createIfAbsent(options.objectPath, JSON.stringify(record));
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    // A parallel cold start won the race; take its key rather than a second one.
    const winner = await options.store.read(options.objectPath);
    if (!winner) throw error;
    return importRecord(JSON.parse(winner) as StoredKey, options.envelope);
  }
  // RULE-53: only this key's own object is written; jwks.json is the publish job's.
  await options.jwksStore.write(`keys/${kid}.json`, JSON.stringify(record.public_jwk));
  return importRecord(record, options.envelope);
}

/** RFC 7638 for RSA: the members are `e`, `kty` and `n`, in that order. */
export async function deriveKid(prefix: string, publicJwk: JsonWebKey): Promise<string> {
  const thumbprint = await sha256Base64Url(JSON.stringify({ e: publicJwk.e, kty: 'RSA', n: publicJwk.n }));
  return `${prefix}-${thumbprint.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()}`;
}

interface StoredKey {
  kid: string;
  alg: 'RS256';
  encrypted_private_jwk: string;
  public_jwk: JsonWebKey & { kid: string; alg: 'RS256'; use: 'sig' };
  created_at: string;
}

async function importRecord(record: StoredKey, envelope: Envelope): Promise<SigningKeyMaterial> {
  const privateJwk = JSON.parse(await envelope.decrypt(record.encrypted_private_jwk)) as JsonWebKey;
  return {
    kid: record.kid,
    privateKey: await webcrypto.subtle.importKey('jwk', privateJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']),
    publicJwk: record.public_jwk,
  };
}

/** SIGNER_MODE=local: the key comes from the environment and no bucket is touched. */
export async function localSigningKey(jwkJson: string, kidPrefix: string): Promise<SigningKeyMaterial> {
  const privateJwk = JSON.parse(jwkJson) as JsonWebKey;
  const kid = await deriveKid(kidPrefix, privateJwk);
  return {
    kid,
    privateKey: await webcrypto.subtle.importKey('jwk', privateJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']),
    publicJwk: { kty: 'RSA', n: privateJwk.n!, e: privateJwk.e!, kid, alg: 'RS256', use: 'sig' },
  };
}

/** Test helper: a fresh RSA key pair in the shape localSigningKey expects. */
export async function generateLocalSigningJwk(): Promise<string> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  return JSON.stringify(await webcrypto.subtle.exportKey('jwk', pair.privateKey));
}
