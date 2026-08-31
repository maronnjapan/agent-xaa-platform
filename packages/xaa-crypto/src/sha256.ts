import { webcrypto } from 'node:crypto';
import { encodeBase64Url } from './base64url.js';

export async function sha256(input: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Base64Url(input: Uint8Array | string): Promise<string> {
  return encodeBase64Url(await sha256(input));
}
