import { describe, expect, it } from 'vitest';
import { decodeBase64Url, decodeBase64UrlToString, encodeBase64Url, XaaCryptoError } from '../src/index.js';

describe('base64url', () => {
  it.each([['f', 'Zg'], ['fo', 'Zm8'], ['foobar', 'Zm9vYmFy']])('round trips RFC 4648 vector %s', (plain, encoded) => {
    expect(encodeBase64Url(plain)).toBe(encoded);
    expect(decodeBase64UrlToString(encoded)).toBe(plain);
  });
  it.each(['aGVsbG8=', 'aGVs bG8', 'a'])('rejects invalid value %s', (value) => {
    expect(() => decodeBase64Url(value)).toThrowError(expect.objectContaining<XaaCryptoError>({ code: 'invalid_base64url' }));
  });
});
