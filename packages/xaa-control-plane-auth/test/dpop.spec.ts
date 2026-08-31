import { createDpopProof, generateEs256KeyPair, InMemoryJtiStore, jwkThumbprint } from '@xaa/crypto';
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
  it('rejects a replayed proof', async () => {
    const { app, token, boundPair } = await setup();
    const proof = await createDpopProof({ method: 'POST', url: 'http://x/x?ignored=yes', keyPair: boundPair, accessToken: token });
    expect((await app.request('http://x/x?ignored=yes', { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } })).status).toBe(200);
    expect(await (await app.request('http://x/x?ignored=yes', { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } })).json()).toEqual({ error: 'replayed_dpop_proof' });
  });
});
