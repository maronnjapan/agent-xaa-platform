import { describe, expect, it } from 'vitest';
import vector from './fixtures/ec-thumbprint-vector.json' with { type: 'json' };
import { jwkThumbprint, XaaCryptoError, type PublicJwkEs256 } from '../src/index.js';

const jwk = vector.jwk as PublicJwkEs256;

describe('RFC 7638 thumbprint', () => {
  it('matches committed EC vector', async () => {
    expect(await jwkThumbprint(jwk)).toBe(vector.thumbprint);
  });

  it('swapping x and y changes the thumbprint', async () => {
    expect(await jwkThumbprint({ ...jwk, x: jwk.y, y: jwk.x })).not.toBe(vector.thumbprint);
  });

  it('rejects RSA jwk', async () => {
    await expect(jwkThumbprint({ kty: 'RSA', n: 'x', e: 'AQAB' } as unknown as PublicJwkEs256))
      .rejects.toBeInstanceOf(XaaCryptoError);
  });
});
