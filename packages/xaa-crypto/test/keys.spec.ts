import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair, importPublicJwk, toPublicJwk } from '../src/index.js';
import { exportPrivateJwk } from '../src/testing/private-jwk.js';

describe('ES256 keys', () => {
  it('generates P-256 key pair with 4-member public jwk', async () => {
    const pair = await generateEs256KeyPair();
    expect(Object.keys(pair.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    await expect(importPublicJwk(pair.publicJwk)).resolves.toBeDefined();
  });
  it('rejects a private key passed to toPublicJwk', async () => {
    const pair = await generateEs256KeyPair();
    // The exported JWK of a private key carries `d`, and that member is exactly what
    // makes it unfit for publication, so the guard fires before anything is returned.
    await expect(toPublicJwk(pair.privateKey)).rejects.toMatchObject({ code: 'invalid_jwk' });
    await expect(exportPrivateJwk(pair.privateKey)).resolves.toHaveProperty('d');
  });
  it('rejects an RSA jwk', async () => {
    await expect(importPublicJwk({ kty: 'RSA', n: 'sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri23bOdgWp4Dy1Wl', e: 'AQAB' }))
      .rejects.toMatchObject({ code: 'invalid_jwk' });
  });
});
