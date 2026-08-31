import type { MiddlewareHandler } from 'hono';
import { verifyGoogleServiceIdentity } from '@xaa/contracts';

export interface InternalOidcOptions {
  audience: string;
  allowedCallers: readonly string[];
  fetchImpl?: typeof fetch;
  /** Test seam: resolves a bearer token to a caller email. */
  verify?(token: string, audience: string): Promise<string | null>;
}

/**
 * Who may call the internal routes.
 *
 * Cloud Scheduler and the other services reach this app with a Google-signed OIDC
 * token for their own service account. Checking the email against a named list is what
 * keeps `/internal/tick` and the transition API from being a way for anything inside
 * the network to destroy an agent.
 */
export function requireInternalCaller(options: InternalOidcOptions): MiddlewareHandler {
  return async (context, next) => {
    const header = context.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return context.json({ error: 'caller_not_allowed' }, 403);
    let email: string | null;
    try {
      email = options.verify
        ? await options.verify(token, options.audience)
        : String((await verifyGoogleServiceIdentity(token, {
            audience: options.audience,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          })).email ?? '');
    } catch {
      return context.json({ error: 'caller_not_allowed' }, 403);
    }
    if (!email || !options.allowedCallers.some((allowed) => email!.startsWith(allowed))) {
      return context.json({ error: 'caller_not_allowed' }, 403);
    }
    context.set('callerEmail' as never, email as never);
    await next();
    return undefined;
  };
}
