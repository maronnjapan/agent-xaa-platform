import { describe, expect, it } from 'vitest';
import { createDpopProof, decodeJwsUnverified, generateEs256KeyPair, InMemoryJtiStore, normalizeHtu, sha256Base64Url, verifyDpopProof } from '../src/index.js';

describe('DPoP', () => {
  it('includes ath when access token is given', async () => {
    const keyPair = await generateEs256KeyPair();
    const token = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair, accessToken: 'access' });
    expect(decodeJwsUnverified(token).payload.ath).toBe(await sha256Base64Url('access'));
  });
  it('normalizes htu', () => expect(normalizeHtu('HTTPS://Example.COM:443/xaa/token?a=1#f')).toBe('https://example.com/xaa/token'));
  it('rejects htm mismatch', async () => {
    const keyPair = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair });
    await expect(verifyDpopProof(proof, { method: 'POST', url: 'https://example.com/a', jtiStore: new InMemoryJtiStore() })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
  });
  it('rejects replayed jti', async () => {
    const keyPair = await generateEs256KeyPair();
    const store = new InMemoryJtiStore();
    const proof = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair });
    await verifyDpopProof(proof, { method: 'GET', url: 'https://example.com/a', jtiStore: store });
    await expect(verifyDpopProof(proof, { method: 'GET', url: 'https://example.com/a', jtiStore: store })).rejects.toMatchObject({ code: 'replayed_dpop_proof' });
  });
});
