import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { accessTokenMiddleware, type ControlPlaneVariables } from '../src/index.js';
import { accessToken, setupIssuer } from './helpers.js';

/**
 * REQ-02-013 / T-IDP-12. The four operation scopes and the three Control Plane
 * audiences are one contract shared by Authorization Platform, Agent Provisioner and
 * Lifecycle Manager. Each app mounts this middleware on its own routes; this spec
 * pins the behaviour they all rely on.
 */
const MOUNTS = [
  { scope: 'workdef:submit', audience: 'authorization-platform' },
  { scope: 'agent:provision', audience: 'agent-provisioner' },
  { scope: 'agent:revoke', audience: 'lifecycle-manager' },
  { scope: 'agent:operate', audience: 'automation-app' },
] as const;

describe('control plane scope guard contract', () => {
  let issuer: Awaited<ReturnType<typeof setupIssuer>>;
  beforeAll(async () => { issuer = await setupIssuer(); });

  const call = async (token: string, mount: { scope: string; audience: string }) => {
    const app = new Hono<{ Variables: ControlPlaneVariables }>();
    app.use('/protected', accessTokenMiddleware({
      issuer: 'https://issuer.example', jwksUrl: 'https://jwks.example',
      audience: mount.audience, requiredScope: mount.scope, fetchImpl: issuer.fetchImpl,
    }));
    app.post('/protected', (context) => context.json({ sub: context.get('accessToken').sub }));
    return app.request('/protected', { method: 'POST', headers: { Authorization: `DPoP ${token}` } });
  };

  for (const mount of MOUNTS) {
    it(`accepts ${mount.scope} at ${mount.audience}`, async () => {
      const token = await accessToken(issuer.pair, { aud: [mount.audience, 'https://issuer.example/userinfo'], scope: mount.scope });
      expect((await call(token, mount)).status).toBe(200);
    });

    it(`returns 403 insufficient_scope without ${mount.scope}`, async () => {
      const token = await accessToken(issuer.pair, { aud: [mount.audience], scope: 'openid' });
      const response = await call(token, mount);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'insufficient_scope' });
    });
  }

  it('rejects an id token with 401', async () => {
    const token = await accessToken(issuer.pair, { aud: ['authorization-platform'] }, 'JWT');
    const response = await call(token, MOUNTS[0]);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
  });

  it('rejects an ID-JAG with 401', async () => {
    const token = await accessToken(issuer.pair, { aud: ['authorization-platform'] }, 'oauth-id-jag+jwt');
    expect((await call(token, MOUNTS[0])).status).toBe(401);
  });

  it('rejects the wrong audience with 401', async () => {
    const token = await accessToken(issuer.pair, { aud: ['lifecycle-manager'], scope: 'workdef:submit' });
    const response = await call(token, MOUNTS[0]);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_audience' });
  });

  it('answers 401 with a DPoP challenge, never Bearer', async () => {
    const response = await call('not-a-token', MOUNTS[0]);
    expect(response.headers.get('WWW-Authenticate')).toBe('DPoP error="invalid_token"');
  });
});
