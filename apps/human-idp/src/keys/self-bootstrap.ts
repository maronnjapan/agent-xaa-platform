import { webcrypto } from 'node:crypto';
import { encodeBase64Url, sha256 } from '@xaa/crypto';

/**
 * The SSO signing key. DEC-ID-17: core's SigningKeyProvider wants a CryptoKey, so
 * the private key cannot live in KMS. It is generated here, wrapped with the KMS
 * ENCRYPT_DECRYPT key and stored in a private bucket, so `terraform apply` alone
 * brings the provider up with no manual key ceremony.
 */
export interface WrappedKeyRecord {
  kid: string;
  alg: 'RS256';
  encrypted_private_jwk: string;
  public_jwk: JsonWebKey;
  created_at: string;
}

export interface ObjectStore {
  /** Resolves to null when the object does not exist. */
  read(path: string): Promise<string | null>;
  /** Must reject with a PreconditionFailed-shaped error when the object already exists. */
  createIfAbsent(path: string, body: string): Promise<void>;
  write(path: string, body: string, options?: { public?: boolean }): Promise<void>;
}

export interface Envelope {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export const SSO_KEY_OBJECT = 'sso-signing/current.json';

export function isPreconditionFailed(error: unknown): boolean {
  const code = (error as { code?: number | string; status?: number })?.code ?? (error as { status?: number })?.status;
  return code === 412 || code === '412';
}

/** RFC 7638 thumbprint of an RSA public JWK, base32-lowercased to 8 characters. */
export async function deriveIdpKid(publicJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ e: publicJwk.e, kty: publicJwk.kty, n: publicJwk.n });
  const digest = await sha256(canonical);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 8) break;
  }
  return `idp-${out.slice(0, 8)}`;
}

async function generate(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey; kid: string }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateJwk, publicJwk, kid: await deriveIdpKid(publicJwk) };
}

export interface BootstrapResult {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

async function importRecord(record: WrappedKeyRecord, envelope: Envelope): Promise<BootstrapResult> {
  const privateJwk = JSON.parse(await envelope.decrypt(record.encrypted_private_jwk)) as JsonWebKey;
  const privateKey = await webcrypto.subtle.importKey(
    'jwk', privateJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  return { kid: record.kid, privateKey, publicJwk: record.public_jwk };
}

/**
 * Idempotent and safe under concurrent cold starts: creation uses the object
 * store's create-if-absent precondition, and a losing writer re-reads the winner's
 * object instead of retrying with its own key.
 */
export async function bootstrapSigningKey(options: {
  store: ObjectStore;
  envelope: Envelope;
  jwksStore: ObjectStore;
}): Promise<BootstrapResult> {
  const existing = await options.store.read(SSO_KEY_OBJECT);
  if (existing) return importRecord(JSON.parse(existing) as WrappedKeyRecord, options.envelope);

  const generated = await generate();
  const record: WrappedKeyRecord = {
    kid: generated.kid,
    alg: 'RS256',
    encrypted_private_jwk: await options.envelope.encrypt(JSON.stringify(generated.privateJwk)),
    public_jwk: { ...generated.publicJwk, kid: generated.kid, alg: 'RS256', use: 'sig' } as JsonWebKey,
    created_at: new Date().toISOString(),
  };
  try {
    await options.store.createIfAbsent(SSO_KEY_OBJECT, JSON.stringify(record));
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    const winner = await options.store.read(SSO_KEY_OBJECT);
    if (!winner) throw error;
    return importRecord(JSON.parse(winner) as WrappedKeyRecord, options.envelope);
  }
  // RULE-53: each app writes only its own object under keys/. jwks.json is produced
  // by the jwks-publish job, never by an application.
  await options.jwksStore.write(`keys/${record.kid}.json`, JSON.stringify(record.public_jwk), { public: true });
  return importRecord(record, options.envelope);
}

export function encodeForTest(value: Uint8Array): string {
  return encodeBase64Url(value);
}
