import { webcrypto } from 'node:crypto';
import { decodeBase64Url, decodeBase64UrlToString } from './base64url.js';
import { decodeJwsUnverified, verifyCompactJws } from './jws.js';
import type { JwksCache } from './jwks-cache.js';
import { XaaCryptoError } from './errors.js';

function includesAudience(aud: unknown, expected: string): boolean {
  return typeof aud === 'string' ? aud === expected : Array.isArray(aud) && aud.some((value) => value === expected);
}

function claimsValid(payload: Record<string, unknown>, now = Math.floor(Date.now() / 1000)): boolean {
  return typeof payload.exp === 'number' && payload.exp >= now - 60 && (payload.nbf === undefined || (typeof payload.nbf === 'number' && payload.nbf <= now + 60));
}

async function verifyJwtInternal(token: string, options: { issuer: string; audience: string; jwks: JwksCache; typ: string; resource?: string }): Promise<Record<string, unknown>> {
  try {
    const unverified = decodeJwsUnverified(token);
    if (typeof unverified.header.kid !== 'string') throw new Error();
    const verified = await verifyCompactJws(token, { publicKey: await options.jwks.getKey(unverified.header.kid), allowedTyp: [options.typ] });
    if (verified.payload.iss !== options.issuer || !includesAudience(verified.payload.aud, options.audience) || !claimsValid(verified.payload)) throw new Error();
    if (options.resource !== undefined && verified.payload.resource !== options.resource) throw new Error();
    return verified.payload;
  } catch {
    throw new XaaCryptoError('invalid_signature', 'token verification failed');
  }
}

export function verifyHumanAccessToken(token: string, options: { issuer: string; jwks: JwksCache; audience: string }): Promise<Record<string, unknown>> {
  return verifyJwtInternal(token, { ...options, typ: 'at+jwt' });
}

export function verifyHumanIdToken(token: string, options: { issuer: string; jwks: JwksCache; audience: string }): Promise<Record<string, unknown>> {
  return verifyJwtInternal(token, { ...options, typ: 'JWT' });
}

export async function verifyIdJag(token: string, options: { issuer: string; jwks: JwksCache; audience: string; resource: string }): Promise<Record<string, unknown>> {
  const payload = await verifyJwtInternal(token, { ...options, typ: 'oauth-id-jag+jwt' });
  if (payload.aud !== options.audience) throw new XaaCryptoError('invalid_signature', 'token verification failed');
  return payload;
}

export async function verifyGoogleServiceIdentity(token: string, options: { audience: string; fetchImpl?: typeof fetch }): Promise<Record<string, unknown>> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(decodeBase64UrlToString(parts[0]!));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !['JWT', 'at+jwt'].includes(header.typ ?? 'JWT')) throw new Error();
    const response = await (options.fetchImpl ?? fetch)('https://www.googleapis.com/oauth2/v3/certs');
    const jwks = await response.json() as { keys: Array<JsonWebKey & { kid?: string }> };
    const jwk = jwks.keys.find((key) => key.kid === header.kid);
    if (!jwk) throw new Error();
    const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64Url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error();
    const payload = JSON.parse(decodeBase64UrlToString(parts[1]!)) as Record<string, unknown>;
    if (payload.iss !== 'https://accounts.google.com' || !includesAudience(payload.aud, options.audience) || !claimsValid(payload)) throw new Error();
    return payload;
  } catch {
    throw new XaaCryptoError('invalid_signature', 'token verification failed');
  }
}
