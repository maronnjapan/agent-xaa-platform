import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import createApp, { STUB_EXTERNAL_SUBJECT } from '../src/index.js';

const BASE = 'https://stub-saas-op.test';
const REDIRECT = 'https://google-bridge-callback.test/stub-saas/oauth/callback';

async function consent(app: ReturnType<typeof createApp>): Promise<{ refreshToken: string }> {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await app.fetch(new Request(
    `${BASE}/authorize?client_id=stub-bridge-client&redirect_uri=${encodeURIComponent(REDIRECT)}`
    + `&response_type=code&scope=calendar.read&state=s&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: 'manual' },
  ));
  const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!;
  const token = await app.fetch(new Request(`${BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
      client_id: 'stub-bridge-client', client_secret: 'stub-bridge-secret', code_verifier: verifier,
    }).toString(),
  }));
  const body = await token.json() as { refresh_token: string };
  return { refreshToken: body.refresh_token };
}

async function refresh(app: ReturnType<typeof createApp>, refreshToken: string): Promise<Response> {
  return app.fetch(new Request(`${BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: 'stub-bridge-client', client_secret: 'stub-bridge-secret',
    }).toString(),
  }));
}

describe('the stub SaaS authorization server', () => {
  it('issues a code for a fixed subject with no login page', async () => {
    const app = createApp();
    const { refreshToken } = await consent(app);
    expect(refreshToken).toBeTruthy();
    const info = await (await app.fetch(new Request(`${BASE}/userinfo`))).json() as { sub: string };
    expect(info.sub).toBe(STUB_EXTERNAL_SUBJECT);
  });

  it('requires PKCE with S256', async () => {
    const app = createApp();
    const plain = await app.fetch(new Request(
      `${BASE}/authorize?client_id=stub-bridge-client&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + '&response_type=code&code_challenge=abc&code_challenge_method=plain',
      { redirect: 'manual' },
    ));
    expect(plain.status).toBe(400);
  });

  it('rotates the refresh token only when told to', async () => {
    const rotating = createApp({ rotateRefreshToken: 'always' });
    const first = await consent(rotating);
    const rotated = await (await refresh(rotating, first.refreshToken)).json() as { refresh_token?: string };
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(first.refreshToken);

    const stable = createApp({ rotateRefreshToken: 'never' });
    const second = await consent(stable);
    const kept = await (await refresh(stable, second.refreshToken)).json() as { refresh_token?: string };
    expect(kept.refresh_token).toBeUndefined();
  });

  it('reads STUB_ROTATE_REFRESH_TOKEN=always when no option is passed', async () => {
    // Terraform sets the variable on the stub's Cloud Run service; nothing passes an
    // option there, so the environment is the switch that has to work.
    const previous = process.env.STUB_ROTATE_REFRESH_TOKEN;
    try {
      process.env.STUB_ROTATE_REFRESH_TOKEN = 'always';
      const rotating = createApp();
      const first = await consent(rotating);
      const rotated = await (await refresh(rotating, first.refreshToken)).json() as { refresh_token?: string };
      expect(rotated.refresh_token).toBeTruthy();
      expect(rotated.refresh_token).not.toBe(first.refreshToken);

      process.env.STUB_ROTATE_REFRESH_TOKEN = 'never';
      const stable = createApp();
      const second = await consent(stable);
      const kept = await (await refresh(stable, second.refreshToken)).json() as { refresh_token?: string };
      expect(kept.refresh_token).toBeUndefined();

      delete process.env.STUB_ROTATE_REFRESH_TOKEN;
      const byDefault = createApp();
      const third = await consent(byDefault);
      const unset = await (await refresh(byDefault, third.refreshToken)).json() as { refresh_token?: string };
      // Unset means `never`: rotation is the behaviour a test asks for on purpose.
      expect(unset.refresh_token).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.STUB_ROTATE_REFRESH_TOKEN;
      else process.env.STUB_ROTATE_REFRESH_TOKEN = previous;
    }
  });

  it('answers invalid_grant after the refresh token is revoked', async () => {
    const app = createApp();
    const { refreshToken } = await consent(app);
    expect((await refresh(app, refreshToken)).status).toBe(200);
    await app.fetch(new Request(`${BASE}/internal/revoke-refresh-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }),
    }));
    const after = await refresh(app, refreshToken);
    expect(after.status).toBe(400);
    expect(await after.json()).toEqual({ error: 'invalid_grant' });
  });

  it('checks the client secret', async () => {
    const app = createApp();
    const response = await app.fetch(new Request(`${BASE}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: 'x',
        client_id: 'stub-bridge-client', client_secret: 'wrong',
      }).toString(),
    }));
    expect(response.status).toBe(401);
  });
});
