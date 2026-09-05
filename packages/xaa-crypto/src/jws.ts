import { webcrypto } from 'node:crypto';
import { decodeBase64Url, decodeBase64UrlToString, encodeBase64Url } from './base64url.js';
import { XaaCryptoError } from './errors.js';
import { importPublicJwk, type PublicJwkEs256 } from './keys.js';

export interface Es256Signer {
  kid: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface JwsHeader {
  alg: 'ES256';
  typ: string;
  kid?: string;
  jwk?: PublicJwkEs256;
}

const HEADER_KEYS = new Set(['alg', 'typ', 'kid', 'jwk']);

export async function signCompactJws(input: {
  header: JwsHeader;
  payload: Record<string, unknown>;
  signer: Es256Signer;
}): Promise<string> {
  const encodedHeader = encodeBase64Url(JSON.stringify(input.header));
  const encodedPayload = encodeBase64Url(JSON.stringify(input.payload));
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await input.signer.sign(signingInput);
  if (signature.byteLength !== 64) throw new XaaCryptoError('invalid_signature');
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
}

function decodePart(value: string, kind: 'header' | 'payload'): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(decodeBase64UrlToString(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new XaaCryptoError(kind === 'header' ? 'invalid_jws_header' : 'invalid_signature');
  }
}

/** Unverified decoding is only suitable for diagnostics and tests. */
export function decodeJwsUnverified(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) throw new XaaCryptoError('invalid_signature');
  return { header: decodePart(parts[0]!, 'header'), payload: decodePart(parts[1]!, 'payload') };
}

export async function verifyCompactJws(token: string, options: {
  publicKey?: CryptoKey;
  allowedTyp: readonly string[];
  allowEmbeddedJwk?: boolean;
}): Promise<{ header: JwsHeader; payload: Record<string, unknown> }> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) throw new XaaCryptoError('invalid_signature');
  const rawHeader = decodePart(parts[0]!, 'header');
  if (Object.keys(rawHeader).some((key) => !HEADER_KEYS.has(key))) throw new XaaCryptoError('invalid_jws_header');
  if (rawHeader.alg !== 'ES256' || typeof rawHeader.typ !== 'string') throw new XaaCryptoError('invalid_jws_header');
  if (rawHeader.jwk !== undefined && !options.allowEmbeddedJwk) throw new XaaCryptoError('invalid_jws_header');
  if (rawHeader.kid !== undefined && typeof rawHeader.kid !== 'string') throw new XaaCryptoError('invalid_jws_header');
  const publicKey = rawHeader.jwk !== undefined
    ? await importPublicJwk(rawHeader.jwk)
    : options.publicKey;
  if (!publicKey) throw new XaaCryptoError('invalid_jwk');
  let valid: boolean;
  try {
    valid = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      decodeBase64Url(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new XaaCryptoError('invalid_signature');
  if (!options.allowedTyp.includes(rawHeader.typ)) throw new XaaCryptoError('invalid_jws_header');
  const payload = decodePart(parts[1]!, 'payload');
  return { header: rawHeader as unknown as JwsHeader, payload };
}

/**
 * RS256 verification, kept separate from the ES256 path on purpose.
 *
 * The Resource AS and the Human IdP both sign with RSA-2048, because core's discovery
 * builder requires an RS256 key (00b). The two algorithms never share a verification
 * function: the caller picks this one only when the header says RS256, and the key it
 * hands over came from the JWKS by `kid`, so an ES256 key can never be made to accept
 * an RS256 signature — `subtle.verify` rejects the mismatch rather than reinterpreting
 * the algorithm.
 */
export async function verifyCompactJwsRs256(token: string, options: {
  publicKey: CryptoKey;
  allowedTyp: readonly string[];
}): Promise<{ header: JwsHeader; payload: Record<string, unknown> }> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) throw new XaaCryptoError('invalid_signature');
  const rawHeader = decodePart(parts[0]!, 'header');
  if (Object.keys(rawHeader).some((key) => !HEADER_KEYS.has(key))) throw new XaaCryptoError('invalid_jws_header');
  if (rawHeader.alg !== 'RS256' || typeof rawHeader.typ !== 'string') throw new XaaCryptoError('invalid_jws_header');
  if (rawHeader.jwk !== undefined) throw new XaaCryptoError('invalid_jws_header');
  let valid: boolean;
  try {
    valid = await webcrypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      options.publicKey,
      decodeBase64Url(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new XaaCryptoError('invalid_signature');
  if (!options.allowedTyp.includes(rawHeader.typ)) throw new XaaCryptoError('invalid_jws_header');
  return { header: rawHeader as unknown as JwsHeader, payload: decodePart(parts[1]!, 'payload') };
}
