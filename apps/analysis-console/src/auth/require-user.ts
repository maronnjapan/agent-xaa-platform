import type { MiddlewareHandler } from 'hono';
import { readSessionCookie, type SessionStore } from './session-store.js';

export interface UserVariables {
  Variables: { humanSubject: string };
}

/**
 * Who is asking, decided once, for every route below it.
 *
 * The subject comes out of the server-side session and from nowhere else — never from a
 * query parameter, a header or a token the request carried. Everything the screen then
 * reads is narrowed to it (RULE-56), so this is the single place in this app that
 * decides whose findings a request may see.
 *
 * An expired session is refused rather than renewed. This app has no refresh token to
 * renew one with, by design, so the honest answer is to log in again.
 *
 * The refusal is a redirect, not a 401 body: the thing on the other end is a browser,
 * and every reason to say no here — no cookie, an unknown session, an expired one —
 * ends in the same place, which is the login screen.
 */
export function requireUser(options: {
  sessions: SessionStore;
  now?: () => number;
}): MiddlewareHandler<UserVariables> {
  const now = options.now ?? (() => Date.now());
  return async (context, next) => {
    const sessionId = readSessionCookie(context.req.header('cookie'));
    const session = sessionId ? await options.sessions.find(sessionId) : undefined;
    if (!session || Date.parse(session.expires_at) <= now()) return context.redirect('/login', 302);
    context.set('humanSubject', session.human_subject);
    await next();
    return undefined;
  };
}
