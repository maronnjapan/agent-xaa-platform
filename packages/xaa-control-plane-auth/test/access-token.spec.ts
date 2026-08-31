import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { accessTokenMiddleware, type ControlPlaneVariables } from '../src/index.js';
import { accessToken, setupIssuer } from './helpers.js';

describe('access token middleware', () => {
  let issuer: Awaited<ReturnType<typeof setupIssuer>>;
  beforeAll(async () => { issuer = await setupIssuer(); });
  async function request(token: string, options: { audience?: string; scope?: string } = {}) {
    const app = new Hono<{ Variables: ControlPlaneVariables }>();
    app.use('/protected', accessTokenMiddleware({ issuer: 'https://issuer.example', jwksUrl: 'https://jwks.example', audience: options.audience ?? 'authorization-platform', requiredScope: options.scope ?? 'workdef:submit', fetchImpl: issuer.fetchImpl }));
    app.post('/protected', (context) => context.json(context.get('accessToken')));
    return app.request('/protected', { method: 'POST', headers: { Authorization: `DPoP ${token}` } });
  }
  it('rejects a tampered payload (401)', async () => {
    // The payload segment is altered rather than the signature's last character:
    // that character only carries padding bits, so changing it can leave the
    // decoded signature identical and the test would pass or fail by luck.
    const [header, payload, signature] = (await accessToken(issuer.pair)).split('.');
    const tampered = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')), sub: 'someone-else',
    })).toString('base64url');
    expect((await request(`${header}.${tampered}.${signature}`)).status).toBe(401);
  });
  it('rejects typ=JWT id token (401 invalid_token)', async () => expect(await (await request(await accessToken(issuer.pair, {}, 'JWT'))).json()).toEqual({ error: 'invalid_token' }));
  it('rejects aud=authorization-platform on agent-provisioner (401 invalid_audience)', async () => expect(await (await request(await accessToken(issuer.pair), { audience: 'agent-provisioner' })).json()).toEqual({ error: 'invalid_audience' }));
  it('rejects missing scope (403 insufficient_scope)', async () => expect((await request(await accessToken(issuer.pair), { scope: 'agent:provision' })).status).toBe(403));
  it('does not accept audience prefixes', async () => expect((await request(await accessToken(issuer.pair, { aud: ['authorization-platform-staging'] }))).status).toBe(401));
  it('does not retain the raw token in verified claims', async () => {
    const token = await accessToken(issuer.pair);
    expect(JSON.stringify(await (await request(token)).json())).not.toContain(token);
  });
});
