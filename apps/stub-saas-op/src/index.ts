import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { encodeBase64Url } from '@xaa/crypto';

export interface StubSaasOpDeps {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  /** `always` returns a new refresh token on every grant; `never` keeps the first. */
  rotateRefreshToken?: 'always' | 'never';
  signingSecret?: string;
  now?: () => number;
}

export const STUB_EXTERNAL_SUBJECT = 'stub-user-001';

interface AuthCode { code_challenge: string; scope: string; redirect_uri: string }

/**
 * A stand-in for the external SaaS's authorization server.
 *
 * It is deliberately not built from this platform's OIDC generator. The generator gives
 * the platform's own providers a conformant implementation to patch; this app plays the
 * part of somebody else's OAuth server, and a faithful stub of that is a small amount of
 * code with obvious behaviour.
 *
 * `/authorize` issues a code immediately for a fixed subject. There is no login page and
 * no consent screen, because a browser click in the middle of a Bridge test would be
 * testing the stub rather than the Bridge.
 */
function createApp(deps: StubSaasOpDeps = {}): Hono {
  const app = new Hono();
  const clientId = deps.clientId ?? 'stub-bridge-client';
  const clientSecret = deps.clientSecret ?? 'stub-bridge-secret';
  const signingSecret = deps.signingSecret ?? 'stub-shared-hmac-secret';
  const now = deps.now ?? (() => Date.now());
  const rotate = () => deps.rotateRefreshToken ?? (process.env.STUB_ROTATE_REFRESH_TOKEN === 'always' ? 'always' : 'never');

  const codes = new Map<string, AuthCode>();
  const refreshTokens = new Map<string, { scope: string; revoked: boolean }>();

  app.get('/livez', (context) => context.json({ status: 'ok', app: 'stub-saas-op' }));

  app.get('/.well-known/openid-configuration', (context) => context.json({
    issuer: deps.issuer ?? 'https://stub-saas-op.test',
    authorization_endpoint: `${deps.issuer ?? 'https://stub-saas-op.test'}/authorize`,
    token_endpoint: `${deps.issuer ?? 'https://stub-saas-op.test'}/token`,
    userinfo_endpoint: `${deps.issuer ?? 'https://stub-saas-op.test'}/userinfo`,
  }));

  app.get('/authorize', (context) => {
    const query = context.req.query();
    if (query.client_id !== clientId) return context.json({ error: 'invalid_client' }, 400);
    if (query.code_challenge_method !== 'S256' || !query.code_challenge) {
      // PKCE is required and only S256 is accepted: `plain` puts the verifier in the
      // request it is supposed to protect.
      return context.json({ error: 'invalid_request' }, 400);
    }
    const code = encodeBase64Url(new Uint8Array(randomBytes(24)));
    codes.set(code, {
      code_challenge: query.code_challenge,
      scope: query.scope ?? '',
      redirect_uri: query.redirect_uri ?? '',
    });
    const location = new URL(query.redirect_uri ?? 'https://invalid.test');
    location.searchParams.set('code', code);
    if (query.state) location.searchParams.set('state', query.state);
    return context.redirect(location.toString(), 302);
  });

  app.post('/token', async (context) => {
    const form = await context.req.parseBody() as Record<string, string>;
    if (form.client_id !== clientId || form.client_secret !== clientSecret) {
      return context.json({ error: 'invalid_client' }, 401);
    }

    if (form.grant_type === 'authorization_code') {
      const record = codes.get(form.code ?? '');
      if (!record) return context.json({ error: 'invalid_grant' }, 400);
      codes.delete(form.code!);
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (challenge !== record.code_challenge) return context.json({ error: 'invalid_grant' }, 400);
      const refreshToken = encodeBase64Url(new Uint8Array(randomBytes(24)));
      refreshTokens.set(refreshToken, { scope: record.scope, revoked: false });
      return context.json({
        access_token: mintAccessToken(record.scope),
        refresh_token: refreshToken,
        id_token: mintIdToken(),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: record.scope,
      });
    }

    if (form.grant_type === 'refresh_token') {
      const record = refreshTokens.get(form.refresh_token ?? '');
      if (!record || record.revoked) return context.json({ error: 'invalid_grant' }, 400);
      const scope = form.scope ?? record.scope;
      const body: Record<string, unknown> = {
        access_token: mintAccessToken(scope), token_type: 'Bearer', expires_in: 3600, scope,
      };
      if (rotate() === 'always') {
        refreshTokens.delete(form.refresh_token!);
        const next = encodeBase64Url(new Uint8Array(randomBytes(24)));
        refreshTokens.set(next, { scope, revoked: false });
        body.refresh_token = next;
      }
      return context.json(body);
    }

    return context.json({ error: 'unsupported_grant_type' }, 400);
  });

  app.get('/userinfo', (context) => context.json({ sub: STUB_EXTERNAL_SUBJECT, email: 'stub-user@example.test' }));

  /** Only the stub has this. Nothing in the Bridge knows the endpoint exists. */
  app.post('/internal/revoke-refresh-token', async (context) => {
    const body = await context.req.json().catch(() => ({})) as { refresh_token?: string };
    for (const [token, record] of refreshTokens) {
      if (body.refresh_token === undefined || token === body.refresh_token) record.revoked = true;
    }
    return context.body(null, 204);
  });

  return app;

  /**
   * An HMAC over the claims rather than a JWS. The stub API verifies with the same
   * shared secret, so the Bridge test does not depend on a second key infrastructure.
   */
  function mintAccessToken(scope: string): string {
    const claims = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
      sub: STUB_EXTERNAL_SUBJECT, scope, exp: Math.floor(now() / 1000) + 3600,
    })));
    return `${claims}.${createHmac('sha256', signingSecret).update(claims).digest('base64url')}`;
  }

  function mintIdToken(): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ sub: STUB_EXTERNAL_SUBJECT })}.stub`;
  }
}

export default createApp;
