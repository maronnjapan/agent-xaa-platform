import type { MiddlewareHandler } from 'hono';
import { verifyGoogleServiceIdentity } from '@xaa/contracts';

export type CallerRole = 'runtime' | 'provisioner' | 'lifecycle';

export interface CallerAuthzOptions {
  audience: string;
  serviceAccounts: Record<CallerRole, readonly string[]>;
  fetchImpl?: typeof fetch;
  verify?(token: string, audience: string): Promise<string | null>;
  onForbidden?(email: string | null): void;
}

/**
 * Which service accounts may call which route.
 *
 * The Bridge's internal face has three kinds of caller and they are not
 * interchangeable: an agent may exchange a token but not create a binding; the
 * Provisioner may create one but not delete it; the Lifecycle Manager may delete one
 * but never mint a token. Route-level lists make each of those a configuration fact
 * rather than a convention.
 */
export function callerAuthz(roles: readonly CallerRole[], options: CallerAuthzOptions): MiddlewareHandler {
  return async (context, next) => {
    const header = context.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const refuse = (email: string | null): Response => {
      options.onForbidden?.(email);
      return context.json({ error: 'forbidden_caller' }, 403);
    };
    if (!token) return refuse(null);
    let email: string | null;
    try {
      email = options.verify
        ? await options.verify(token, options.audience)
        : String((await verifyGoogleServiceIdentity(token, {
            audience: options.audience,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          })).email ?? '');
    } catch {
      return refuse(null);
    }
    const allowed = roles.flatMap((role) => options.serviceAccounts[role]);
    if (!email || !allowed.some((account) => account !== '' && email!.startsWith(account))) return refuse(email);
    context.set('callerEmail' as never, email as never);
    await next();
    return undefined;
  };
}
