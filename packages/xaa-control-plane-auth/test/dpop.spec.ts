import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, InMemoryJtiStore,
  jwkThumbprint, sha256Base64Url, signCompactJws,
} from '@xaa/crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { accessTokenMiddleware, dpopMiddleware, type ControlPlaneVariables } from '../src/index.js';
import { accessToken, setupIssuer } from './helpers.js';

describe('DPoP middleware', () => {
  let issuer: Awaited<ReturnType<typeof setupIssuer>>;
  beforeEach(async () => { issuer = await setupIssuer(); });
  async function setup(inputPair?: Awaited<ReturnType<typeof generateEs256KeyPair>>) {
    const boundPair = inputPair ?? await generateEs256KeyPair();
    const token = await accessToken(issuer.pair, { cnf: { jkt: await jwkThumbprint(boundPair.publicJwk) } });
    const app = new Hono<{ Variables: ControlPlaneVariables }>();
    app.use('/x', accessTokenMiddleware({ issuer: 'https://issuer.example', jwksUrl: 'https://jwks.example', audience: 'authorization-platform', requiredScope: 'workdef:submit', fetchImpl: issuer.fetchImpl }));
    app.use('/x', dpopMiddleware({ iatSkewSeconds: 60, jtiStore: new InMemoryJtiStore(), expectedHtu: 'http://x/x' }));
    app.post('/x', (context) => context.json(context.get('dpop')));
    return { app, token, boundPair };
  }
  it('rejects stolen token with attacker key proof (401 dpop_key_binding_mismatch)', async () => {
    const { app, token } = await setup();
    const attacker = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'POST', url: 'http://x/x', keyPair: attacker, accessToken: token });
    expect(await (await app.request('http://x/x', { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } })).json()).toEqual({ error: 'dpop_key_binding_mismatch' });
  });
  /**
   * The three ways a proof can be wrong without anyone's key being wrong: it was made
   * for another method, it was made too long ago, or it does not name the token it
   * accompanies. All three are one refusal, because telling them apart would tell a
   * caller which half of a stolen pair still works.
   */
  it.each([
    ['a proof made for GET', async (token: string, pair: Awaited<ReturnType<typeof generateEs256KeyPair>>) =>
      createDpopProof({ method: 'GET', url: 'http://x/x', keyPair: pair, accessToken: token })],
    ['a proof issued five minutes ago', async (token: string, pair: Awaited<ReturnType<typeof generateEs256KeyPair>>) =>
      createDpopProof({ method: 'POST', url: 'http://x/x', keyPair: pair, accessToken: token, now: () => Date.now() - 300_000 })],
    ['a proof with no ath', async (_token: string, pair: Awaited<ReturnType<typeof generateEs256KeyPair>>) =>
      createDpopProof({ method: 'POST', url: 'http://x/x', keyPair: pair })],
  ])('rejects %s with invalid_dpop_proof', async (_name, makeProof) => {
    const { app, token, boundPair } = await setup();
    const proof = await makeProof(token, boundPair);
    const response = await app.request('http://x/x', { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  /**
   * RFC 9449 §4.3 matches htu on scheme, host, port and path only. A client that
   * signed the whole request URI is still bound to this endpoint, so the query is
   * removed on both sides before they are compared rather than refused.
   */
  it('accepts a proof whose htu carries the query string', async () => {
    const { app, token, boundPair } = await setup();
    const proof = await signCompactJws({
      header: { alg: 'ES256', typ: 'dpop+jwt', jwk: boundPair.publicJwk },
      payload: {
        jti: 'proof-with-query', htm: 'POST', htu: 'http://x/x?ignored=yes',
        iat: Math.floor(Date.now() / 1000), ath: await sha256Base64Url(token),
      },
      signer: createLocalEs256Signer({ privateKey: boundPair.privateKey, kid: '' }),
    });
    const response = await app.request('http://x/x?ignored=yes', {
      method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof },
    });
    expect(response.status).toBe(200);
  });

  it('rejects a replayed proof', async () => {
    const { app, token, boundPair } = await setup();
    const proof = await createDpopProof({ method: 'POST', url: 'http://x/x?ignored=yes', keyPair: boundPair, accessToken: token });
    expect((await app.request('http://x/x?ignored=yes', { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } })).status).toBe(200);
    expect(await (await app.request('http://x/x?ignored=yes', { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } })).json()).toEqual({ error: 'replayed_dpop_proof' });
  });
});
