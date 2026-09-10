import type { MiddlewareHandler } from 'hono';
import { audienceIncludes } from '@xaa/contracts';
import { decodeJwsUnverified } from '@xaa/crypto';

/**
 * The operation scope a Human IdP Access Token for this app carries.
 *
 * The Human IdP maps one operation scope to one audience, and `agent:operate` is the
 * one that maps to `automation-app`: "operate the agents this person delegates to",
 * which is what registering a ToDo for an AI to carry out is. There is no second scope
 * for the API, because there is no second audience.
 */
export const TODO_API_SCOPE = 'agent:operate';

export interface BearerTokenOptions {
  clientId: string;
  /** Verifies signature, issuer and expiry; returns the claims. */
  verifyAccessToken(token: string): Promise<Record<string, unknown>>;
  requiredScope: string;
}

export interface BearerVariables {
  Variables: {
    humanSubject: string;
  };
}

/**
 * Resolves who is calling the external API, from a token they present themselves.
 *
 * The screen's guard (`requireUser`) reads the Access Token out of a server-side
 * session, because a browser is never handed one. An API client is the other way
 * round: it holds the token the Human IdP issued it and presents it on every call, so
 * this guard reads the `Authorization` header and nothing else — no cookie, no session,
 * no second way in.
 *
 * The checks are the ones `requireUser` makes, for the same reasons. `typ` is checked
 * against `at+jwt` (DEC-ID-18): under one issuer and one JWK Set an ID Token verifies
 * just as well as an Access Token, and `typ` is the only thing that tells them apart.
 * `aud` is matched element-wise (DEV-12), and the scope has to name this app's
 * operation. `sub` is the person, and every ToDo the call touches is theirs (RULE-43).
 *
 * The refusals follow RFC 6750: a missing or bad token is a 401 with a
 * `WWW-Authenticate` challenge, a token for the wrong scope is a 403.
 */
export function requireBearerToken(options: BearerTokenOptions): MiddlewareHandler<BearerVariables> {
  const challenge = (error?: string): Record<string, string> => ({
    'WWW-Authenticate': error ? `Bearer realm="${options.clientId}", error="${error}"` : `Bearer realm="${options.clientId}"`,
  });
  return async (context, next) => {
    const header = context.req.header('authorization');
    const match = header?.match(/^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/);
    if (!match) return context.json({ error: 'invalid_token' }, 401, challenge());
    const token = match[1]!;

    let claims: Record<string, unknown>;
    try {
      claims = await options.verifyAccessToken(token);
    } catch {
      return context.json({ error: 'invalid_token' }, 401, challenge('invalid_token'));
    }
    if (decodeJwsUnverified(token).header.typ !== 'at+jwt') return context.json({ error: 'invalid_token' }, 401, challenge('invalid_token'));
    if (!audienceIncludes(claims.aud, options.clientId)) return context.json({ error: 'invalid_token' }, 401, challenge('invalid_token'));
    if (typeof claims.sub !== 'string' || claims.sub === '') return context.json({ error: 'invalid_token' }, 401, challenge('invalid_token'));

    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
    if (!scopes.includes(options.requiredScope)) {
      return context.json({ error: 'insufficient_scope' }, 403, challenge('insufficient_scope'));
    }

    // Everything downstream reads this, never `claims.sub` again: one place decides
    // whose ToDos a request may touch.
    context.set('humanSubject', claims.sub);
    await next();
    return undefined;
  };
}
