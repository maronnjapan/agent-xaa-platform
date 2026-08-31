import type { MiddlewareHandler } from 'hono';
import { audienceIncludes } from '@xaa/contracts';
import { decodeJwsUnverified } from '@xaa/crypto';
import { readSessionCookie, type Session, type SessionStore } from './session-store.js';

export interface RequireUserOptions {
  sessions: SessionStore;
  clientId: string;
  /** Verifies signature, issuer and expiry; returns the claims. */
  verifyAccessToken(token: string): Promise<Record<string, unknown>>;
  onDenied?(operation: string): void;
}

export interface UserVariables {
  Variables: {
    humanSubject: string;
    session: Session;
  };
}

/**
 * Resolves who is asking, once, for every route below it.
 *
 * The Access Token comes out of the server-side session rather than off the request,
 * so a page cannot present a token this app never issued a session for. After the
 * signature checks, `typ` is checked against `at+jwt` (DEC-ID-18): under one issuer
 * and one JWK Set an ID Token verifies just as well as an Access Token, and `typ` is
 * the only thing that distinguishes them — without this check, an ID Token meant for
 * the browser would authorise an API call.
 *
 * `aud` is matched element-wise (DEV-12). A substring or prefix test would accept
 * `automation-app-staging` for `automation-app`.
 */
export function requireUser(options: RequireUserOptions): MiddlewareHandler<UserVariables> {
  return async (context, next) => {
    const sessionId = readSessionCookie(context.req.header('cookie'));
    if (!sessionId) return context.json({ error: 'unauthorized' }, 401);
    const session = await options.sessions.find(sessionId);
    if (!session) return context.json({ error: 'unauthorized' }, 401);

    const accessToken = session.access_tokens['automation-app'];
    if (!accessToken) return context.json({ error: 'unauthorized' }, 401);

    let claims: Record<string, unknown>;
    try {
      claims = await options.verifyAccessToken(accessToken);
    } catch {
      return context.json({ error: 'unauthorized' }, 401);
    }
    if (decodeJwsUnverified(accessToken).header.typ !== 'at+jwt') return context.json({ error: 'unauthorized' }, 401);
    if (!audienceIncludes(claims.aud, options.clientId)) return context.json({ error: 'unauthorized' }, 401);
    if (typeof claims.sub !== 'string') return context.json({ error: 'unauthorized' }, 401);

    // Everything downstream reads this, never `claims.sub` again: one place decides
    // whose data a request may touch.
    context.set('humanSubject', claims.sub);
    context.set('session', session);
    await next();
    return undefined;
  };
}
