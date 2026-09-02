import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDpopMiddleware, createDpopProof, decodeJwsUnverified, generateEs256KeyPair, InMemoryJtiStore, jwkThumbprint, normalizeHtu, sha256Base64Url, verifyDpopProof, type JtiStore } from '../src/index.js';

describe('DPoP', () => {
  it('includes ath when access token is given', async () => {
    const keyPair = await generateEs256KeyPair();
    const token = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair, accessToken: 'access' });
    expect(decodeJwsUnverified(token).payload.ath).toBe(await sha256Base64Url('access'));
  });
  it('normalizes htu', () => expect(normalizeHtu('HTTPS://Example.COM:443/xaa/token?a=1#f')).toBe('https://example.com/xaa/token'));
  it('rejects an empty access token', async () => {
    const keyPair = await generateEs256KeyPair();
    await expect(createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair, accessToken: '' }))
      .rejects.toMatchObject({ code: 'invalid_dpop_proof' });
  });
  it('carries only alg, jwk and typ in the header', async () => {
    const keyPair = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair });
    expect(Object.keys(decodeJwsUnverified(proof).header).sort()).toEqual(['alg', 'jwk', 'typ']);
  });
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
  it('rejects htu mismatch', async () => {
    const keyPair = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair });
    await expect(verifyDpopProof(proof, { method: 'GET', url: 'https://example.com/b', jtiStore: new InMemoryJtiStore() }))
      .rejects.toMatchObject({ code: 'invalid_dpop_proof' });
  });
  it('rejects iat out of window', async () => {
    const keyPair = await generateEs256KeyPair();
    const now = 1_700_000_000_000;
    for (const skewSeconds of [-61, 61]) {
      const proof = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair, now: () => now + skewSeconds * 1000 });
      await expect(
        verifyDpopProof(proof, { method: 'GET', url: 'https://example.com/a', jtiStore: new InMemoryJtiStore(), now: () => now }),
        `skew ${skewSeconds}s`,
      ).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
    }
  });
  it('rejects ath mismatch', async () => {
    const keyPair = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair, accessToken: 'one' });
    await expect(verifyDpopProof(proof, { method: 'GET', url: 'https://example.com/a', jtiStore: new InMemoryJtiStore(), accessToken: 'two' }))
      .rejects.toMatchObject({ code: 'invalid_dpop_proof' });
  });
  it('never consumes a jti when the signature does not verify', async () => {
    const keyPair = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'GET', url: 'https://example.com/a', keyPair });
    const parts = proof.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}AA`;
    const consume = vi.fn<JtiStore['consume']>(async () => true);
    await expect(verifyDpopProof(tampered, { method: 'GET', url: 'https://example.com/a', jtiStore: { consume } }))
      .rejects.toMatchObject({ code: 'invalid_dpop_proof' });
    expect(consume).not.toHaveBeenCalled();
  });
});

describe('DPoP middleware', () => {
  const PUBLIC_BASE_URL = 'https://resource.example';
  type DpopEnv = {
    Bindings: { PUBLIC_BASE_URL?: string };
    Variables: { protocolViolationCode: string; dpop: { jkt: string; jti: string } };
  };

  async function callWithProof(input: {
    requireAccessToken: boolean;
    resolveBoundJkt?: (accessToken: string) => Promise<string | undefined>;
    authorization?: string;
    omitProof?: boolean;
  }) {
    const keyPair = await generateEs256KeyPair();
    const accessToken = 'access-token-value';
    const app = new Hono<DpopEnv>();
    app.use('/documents', createDpopMiddleware({
      jtiStore: new InMemoryJtiStore(),
      requireAccessToken: input.requireAccessToken,
      publicBaseUrl: PUBLIC_BASE_URL,
      ...(input.resolveBoundJkt ? { resolveBoundJkt: input.resolveBoundJkt } : {}),
    }));
    app.get('/documents', (context) => context.json({ jkt: context.get('dpop').jkt }));
    const proof = await createDpopProof({ method: 'GET', url: `${PUBLIC_BASE_URL}/documents`, keyPair, accessToken });
    const headers: Record<string, string> = { Authorization: input.authorization ?? `DPoP ${accessToken}` };
    if (!input.omitProof) headers.DPoP = proof;
    const response = await app.request(`${PUBLIC_BASE_URL}/documents`, { headers });
    return { response, keyPair };
  }

  it('rejects Bearer scheme', async () => {
    const { response } = await callWithProof({ requireAccessToken: true, authorization: 'Bearer access-token-value' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('DPoP');
  });

  it('rejects a missing DPoP header', async () => {
    const { response } = await callWithProof({ requireAccessToken: true, omitProof: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('rejects proof signed by other key as dpop_key_binding_mismatch', async () => {
    const other = await generateEs256KeyPair();
    const boundJkt = await jwkThumbprint(other.publicJwk);
    const { response } = await callWithProof({ requireAccessToken: true, resolveBoundJkt: async () => boundJkt });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'dpop_key_binding_mismatch' });
  });

  it('sets dpop.jkt to the thumbprint of the proof jwk', async () => {
    const keyPair = await generateEs256KeyPair();
    const app = new Hono<DpopEnv>();
    app.use('/documents', createDpopMiddleware({ jtiStore: new InMemoryJtiStore(), requireAccessToken: false, publicBaseUrl: PUBLIC_BASE_URL }));
    app.get('/documents', (context) => context.json({ jkt: context.get('dpop').jkt }));
    const proof = await createDpopProof({ method: 'GET', url: `${PUBLIC_BASE_URL}/documents`, keyPair });
    const response = await app.request(`${PUBLIC_BASE_URL}/documents`, { headers: { DPoP: proof } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jkt: await jwkThumbprint(keyPair.publicJwk) });
  });
});
