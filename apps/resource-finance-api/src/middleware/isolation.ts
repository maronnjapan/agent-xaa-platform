import type { MiddlewareHandler } from 'hono';
import type { XaaResourceContext } from '@xaa/resource-guard';

type Env = { Variables: { xaa: XaaResourceContext } };

/**
 * REQ-01-018 / REQ-08-044. Finance only serves an agent running under full
 * isolation. The Authorization Server already checked this at redemption; this
 * check runs anyway, because "the AS checked it" and "the caller passed Cloud Run
 * IAM" are both statements about a different hop, not about this token.
 */
export function requireFullIsolation(): MiddlewareHandler<Env> {
  return async (context, next) => {
    if (context.get('xaa').isolationLevel !== 'full_isolation') {
      return context.json({ error: 'insufficient_isolation' }, 403);
    }
    await next();
  };
}
