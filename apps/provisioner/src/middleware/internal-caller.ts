import type { MiddlewareHandler } from 'hono';
import { verifyGoogleServiceIdentity } from '@xaa/crypto';

export interface InternalCallerOptions {
  /** The Cloud Run URL the token was minted for; anything else is a replay from elsewhere. */
  audience: string;
  allowedCallers: readonly string[];
  fetchImpl?: typeof fetch;
  /** Test seam: resolves a bearer token to a caller email. */
  verify?(token: string, audience: string): Promise<string | null>;
}

/**
 * Who may reach `/internal/*` (00b §4).
 *
 * Lifecycle calls the re-provisioning route with a Google-signed OIDC token for its own
 * service account. Cloud Run's invoker check already says the caller is inside the
 * project; the email check is what says it is `sa-lifecycle` and not any other service
 * that happens to have been granted run.invoker.
 *
 * An empty allow-list refuses everything. The alternative — treating "not configured"
 * as "anyone" — turns a missing Terraform variable into an open agent factory.
 */
export function requireInternalCaller(options: InternalCallerOptions): MiddlewareHandler {
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
    if (!email || !options.allowedCallers.includes(email)) {
      return context.json({ error: 'caller_not_allowed' }, 403);
    }
    await next();
    return undefined;
  };
}
