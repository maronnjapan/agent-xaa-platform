import type { MiddlewareHandler } from 'hono';
import { verifyGoogleServiceIdentity } from '@xaa/crypto';

export interface AdminConsoleVariables {
  Variables: {
    /** The Google account the console attributes every change to. */
    adminPrincipal: string;
  };
}

export type AdminRefusal = 'no_token' | 'invalid_token' | 'not_allowed';

export interface AdminConsoleOptions {
  /** The service's own public base URL: the audience an admin's token must name. */
  audience: string;
  /** `ADMIN_PRINCIPALS`. Empty means nobody, never everybody. */
  allowedPrincipals: readonly string[];
  fetchImpl?: typeof fetch;
  /** Test seam: resolves a bearer token to the account it was minted for. */
  verify?(token: string, audience: string): Promise<string | null>;
  /** Called on every refusal, so a console nobody may reach still leaves a record. */
  onRefusal?(reason: AdminRefusal): void;
}

/**
 * Who may operate a Control Plane admin console.
 *
 * The consoles are not on the public surface (RULE-37): neither the Authorization
 * Platform nor the Provisioner grants `run.invoker` to `allUsers`, so an administrator
 * reaches them through `gcloud run services proxy`, which attaches a Google-signed
 * OIDC token for their own account. Cloud Run's invoker check already says the caller
 * holds a credential in this project; the email check is what says the caller is an
 * administrator and not, say, `sa-automation-app` — which can mint a token for this
 * audience just as easily, and which RULE-07 says must never read the taxonomy.
 *
 * The refusal is the same 403 whichever step failed. A body that distinguished "you
 * sent nothing" from "you are not on the list" would answer, for anyone who can reach
 * the service, whether a given account administers this platform.
 */
export function adminConsoleAuth(options: AdminConsoleOptions): MiddlewareHandler<AdminConsoleVariables> {
  const refuse = (reason: AdminRefusal): { error: string } => {
    options.onRefusal?.(reason);
    return { error: 'admin_only' };
  };

  return async (context, next) => {
    const header = context.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return context.json(refuse('no_token'), 403);

    let principal: string | null;
    try {
      principal = options.verify
        ? await options.verify(token, options.audience)
        : String((await verifyGoogleServiceIdentity(token, {
            audience: options.audience,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          })).email ?? '');
    } catch {
      return context.json(refuse('invalid_token'), 403);
    }
    if (!principal || !options.allowedPrincipals.includes(principal)) {
      return context.json(refuse('not_allowed'), 403);
    }

    context.set('adminPrincipal', principal);
    await next();
    return undefined;
  };
}

/** `ADMIN_PRINCIPALS` as the deployment writes it: a comma-separated list, or nothing. */
export function parseAdminPrincipals(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}
