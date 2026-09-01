import { Hono } from 'hono';
import { webcrypto } from 'node:crypto';
import { audienceIncludes } from '@xaa/contracts';
import {
  createDpopProof, decodeJwsUnverified, generateEs256KeyPair, importPrivateJwk,
  importPublicJwk, type Es256KeyPair, type PublicJwkEs256,
} from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';
import type { AutomationAppConfig } from '../config.js';
import { buildAuthorizationRequest } from './oidc-login.js';
import {
  SESSION_COOKIE, SESSION_TOKEN_AUDIENCES, SESSION_TTL_SECONDS, readSessionCookie,
  type SessionAudience, type SessionStore,
} from './session-store.js';
import { emitLoggedIn } from '../activity/emit.js';

const LOGIN_TTL_SECONDS = 600;
const TOKEN_PLAN: ReadonlyArray<{ audience: SessionAudience; scope: string }> = [
  { audience: 'automation-app', scope: 'agent:operate' },
  { audience: 'authorization-platform', scope: 'workdef:submit' },
  { audience: 'agent-provisioner', scope: 'agent:provision' },
  { audience: 'lifecycle-manager', scope: 'agent:revoke' },
];

interface LoginTransaction {
  stage: number;
  code_verifier: string;
  nonce: string;
  dpop_private_jwk: JsonWebKey;
  id_token: string | null;
  human_subject: string | null;
  access_tokens: Partial<Record<SessionAudience, string>>;
  expires_at: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
}

export function createLoginRoutes(input: {
  config: AutomationAppConfig;
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

  app.get('/', async (context) => {
    const sessionId = readSessionCookie(context.req.header('cookie'));
    if (!sessionId || !await input.sessions.find(sessionId)) return context.redirect('/login');
    return context.html('<!doctype html><meta charset="utf-8"><title>Agent XAA</title><h1>Agent XAA Platform</h1><p>ログイン済みです。</p>');
  });

  app.get('/login', async (context) => {
    const keyPair = await generateEs256KeyPair();
    const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
    const request = await buildAuthorizationRequest({
      issuer: input.config.issuer, clientId: input.config.clientId, redirectUri,
    });
    await input.documents.create('login_transactions', request.state, {
      stage: -1,
      code_verifier: request.codeVerifier,
      nonce: request.nonce,
      dpop_private_jwk: privateJwk,
      id_token: null,
      human_subject: null,
      access_tokens: {},
      expires_at: new Date(now() + LOGIN_TTL_SECONDS * 1000).toISOString(),
    });
    return context.redirect(request.url);
  });

  app.get('/callback', async (context) => {
    const state = context.req.query('state');
    const code = context.req.query('code');
    if (!state || !code || context.req.query('error')) return context.json({ error: 'login_failed' }, 400);
    const transaction = await consume(input.documents, state);
    if (!transaction || Date.parse(transaction.expires_at) <= now()) return context.json({ error: 'invalid_state' }, 400);

    const pair = await keyPairFrom(transaction.dpop_private_jwk);
    const tokenUrl = `${input.config.issuer}/token`;
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${input.config.clientId}:${input.config.clientSecret}`).toString('base64')}`,
    };
    if (transaction.stage >= 0) headers.DPoP = await createDpopProof({ method: 'POST', url: tokenUrl, keyPair: pair });
    const response = await send(tokenUrl, {
      method: 'POST', headers,
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        code_verifier: transaction.code_verifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return context.json({ error: 'token_exchange_failed' }, 502);
    const tokens = await response.json() as TokenResponse;
    if (!tokens.id_token) return context.json({ error: 'invalid_token_response' }, 502);
    let claims: Record<string, unknown>;
    try { claims = await input.verifyIdToken(tokens.id_token); } catch { return context.json({ error: 'invalid_id_token' }, 502); }
    if (claims.nonce !== transaction.nonce || typeof claims.sub !== 'string') {
      return context.json({ error: 'invalid_id_token' }, 502);
    }
    if (transaction.human_subject && transaction.human_subject !== claims.sub) {
      return context.json({ error: 'subject_changed' }, 403);
    }

    const next: LoginTransaction = {
      ...transaction,
      id_token: transaction.id_token ?? tokens.id_token,
      human_subject: transaction.human_subject ?? claims.sub,
    };
    if (transaction.stage >= 0) {
      const target = TOKEN_PLAN[transaction.stage];
      if (!target || !tokens.access_token || tokens.token_type !== 'DPoP') {
        return context.json({ error: 'invalid_token_response' }, 502);
      }
      const accessClaims = decodeJwsUnverified(tokens.access_token).payload;
      if (!audienceIncludes(accessClaims.aud, target.audience)) return context.json({ error: 'invalid_token_audience' }, 502);
      next.access_tokens = { ...next.access_tokens, [target.audience]: tokens.access_token };
    }

    const nextStage = transaction.stage + 1;
    if (nextStage < TOKEN_PLAN.length) {
      const target = TOKEN_PLAN[nextStage]!;
      const request = await buildAuthorizationRequest({
        issuer: input.config.issuer,
        clientId: input.config.clientId,
        redirectUri,
        scope: `openid ${target.scope}`,
      });
      await input.documents.create('login_transactions', request.state, {
        ...next,
        stage: nextStage,
        code_verifier: request.codeVerifier,
        nonce: request.nonce,
      });
      return context.redirect(request.url);
    }

    if (!next.id_token || !next.human_subject || !hasAllTokens(next.access_tokens)) {
      return context.json({ error: 'login_incomplete' }, 502);
    }
    const session = await input.sessions.create({
      human_subject: next.human_subject,
      id_token: next.id_token,
      access_tokens: next.access_tokens,
      dpop_private_jwk: next.dpop_private_jwk,
    }, now());
    await emitLoggedIn({ humanSubject: next.human_subject, occurredAt: new Date(now()).toISOString() });
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
    const value = await tx.get<LoginTransaction>('login_transactions', state);
    if (value) tx.delete('login_transactions', state);
    return value;
  });
}

function hasAllTokens(tokens: Partial<Record<SessionAudience, string>>): tokens is Record<SessionAudience, string> {
  return SESSION_TOKEN_AUDIENCES.every((audience) => typeof tokens[audience] === 'string');
}

function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

async function keyPairFrom(jwk: JsonWebKey): Promise<Es256KeyPair> {
  const publicJwk: PublicJwkEs256 = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
  return {
    privateKey: await importPrivateJwk(jwk),
    publicKey: await importPublicJwk(publicJwk),
    publicJwk,
  };
}
