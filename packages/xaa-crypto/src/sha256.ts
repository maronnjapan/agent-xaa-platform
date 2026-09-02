import { webcrypto } from 'node:crypto';
import { encodeBase64Url } from './base64url.js';

export async function sha256(input: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Base64Url(input: Uint8Array | string): Promise<string> {
  return encodeBase64Url(await sha256(input));
}

/**
 * Lower-case hex. The Tool Manifest digest is carried in this form because the
 * Runtime's integrity check compares hex, and a digest of the same bytes in a
 * different encoding is a mismatch every time.
 */
export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  return [...await sha256(input)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
