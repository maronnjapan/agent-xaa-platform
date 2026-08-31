import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair, importPublicJwk, toPublicJwk } from '../src/index.js';

describe('ES256 keys', () => {
  it('generates P-256 key pair with 4-member public jwk', async () => {
    const pair = await generateEs256KeyPair();
    expect(Object.keys(pair.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    await expect(importPublicJwk(pair.publicJwk)).resolves.toBeDefined();
  });
  it('rejects a private key passed to toPublicJwk', async () => {
    const pair = await generateEs256KeyPair();
    await expect(toPublicJwk(pair.privateKey)).rejects.toMatchObject({ code: 'invalid_jwk' });
  });
});
