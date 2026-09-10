import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { basicClientAuthHeader } from '@xaa/contracts';
import { sha256Base64Url } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';
import type { AnalysisConsoleConfig } from '../config.js';
import { readSessionCookie, sessionCookie, SESSION_COOKIE, type SessionStore } from './session-store.js';

/**
 * `openid profile`, and there is no branch that adds anything.
 *
 * No operation scope, so the Human IdP maps this request to no Control Plane audience
 * and the Access Token it hands back opens nothing (`decideAudience` answers `none`).
 * That is also why the token request below carries no DPoP proof: the IdP's blanket
 * requirement is derived from whether a client holds an operation scope at all, and
 * this one holds none.
 *
 * No `offline_access` either. A refresh token would let this screen keep reading a
 * person's security findings after they have closed it (DEC-ID-13).
 */
export const LOGIN_SCOPE = 'openid profile';

const LOGIN_TTL_SECONDS = 600;

interface LoginTransaction {
  code_verifier: string;
  nonce: string;
  expires_at: string;
}

/**
 * One leg, because one is all this app needs.
 *
 * The Automation App's login walks four legs to collect an Access Token per Control
 * Plane audience. This one wants a name and nothing else: the person proves who they
 * are at the Human IdP, the ID Token says who that is, and the session remembers it.
 * Everything the screen then reads is read as this app, narrowed to that subject.
 */
export function createLoginRoutes(input: {
  config: AnalysisConsoleConfig;
  documents: DocumentStore;
  sessions: SessionStore;
  verifyIdToken(token: string): Promise<Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Hono {
  const app = new Hono();
  const now = input.now ?? (() => Date.now());
  const send = input.fetchImpl ?? globalThis.fetch;
  const redirectUri = `${input.config.publicBaseUrl}/callback`;

  app.get('/login', async (context) => {
    const state = randomUUID();
    const codeVerifier = randomUUID() + randomUUID();
    const nonce = randomUUID();
    await input.documents.create('console_login_transactions', state, {
      code_verifier: codeVerifier,
      nonce,
      expires_at: new Date(now() + LOGIN_TTL_SECONDS * 1000).toISOString(),
    });
    const parameters = new URLSearchParams({
      response_type: 'code',
      client_id: input.config.clientId,
      redirect_uri: redirectUri,
      scope: LOGIN_SCOPE,
      state,
      nonce,
      code_challenge: await sha256Base64Url(codeVerifier),
      code_challenge_method: 'S256',
    });
    return context.redirect(`${input.config.issuer}/authorize?${parameters.toString()}`);
  });

  app.get('/callback', async (context) => {
    const state = context.req.query('state');
    const code = context.req.query('code');
    if (!state || !code || context.req.query('error')) return context.json({ error: 'login_failed' }, 400);
    // Consumed inside a transaction: a code replayed against the same state finds the
    // row already gone rather than minting a second session for it.
    const transaction = await consume(input.documents, state);
    if (!transaction || Date.parse(transaction.expires_at) <= now()) return context.json({ error: 'invalid_state' }, 400);

    const tokenUrl = `${input.config.issuer}/token`;
    const response = await send(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: basicClientAuthHeader(input.config.clientId, input.config.clientSecret),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        code_verifier: transaction.code_verifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return context.json({ error: 'token_exchange_failed' }, 502);
    const tokens = await response.json().catch(() => undefined) as { id_token?: string } | undefined;
    if (!tokens?.id_token) return context.json({ error: 'invalid_token_response' }, 502);

    let claims: Record<string, unknown>;
    try {
      claims = await input.verifyIdToken(tokens.id_token);
    } catch {
      return context.json({ error: 'invalid_id_token' }, 502);
    }
    // The nonce ties this token to the request this app started. Without it, an ID
    // Token minted for some other login of the same person would be accepted here.
    if (claims.nonce !== transaction.nonce || typeof claims.sub !== 'string') {
      return context.json({ error: 'invalid_id_token' }, 502);
    }

    const session = await input.sessions.create(claims.sub, now());
    context.header('Set-Cookie', sessionCookie(session.session_id));
    return context.redirect('/');
  });

  app.post('/logout', async (context) => {
    const sessionId = readSessionCookie(context.req.header('cookie'));
    if (sessionId) await input.sessions.destroy(sessionId);
    context.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return context.body(null, 204);
  });

  return app;
}

async function consume(documents: DocumentStore, state: string): Promise<LoginTransaction | undefined> {
  return documents.transaction(async (tx) => {
    const value = await tx.get<LoginTransaction>('console_login_transactions', state);
    if (value) tx.delete('console_login_transactions', state);
    return value;
  });
}
