import { XaaCryptoError } from './errors.js';

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString('base64url');
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new XaaCryptoError('invalid_base64url');
  }
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function decodeBase64UrlToString(value: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(value));
  } catch (error) {
    if (error instanceof XaaCryptoError) throw error;
    throw new XaaCryptoError('invalid_base64url');
  }
}
