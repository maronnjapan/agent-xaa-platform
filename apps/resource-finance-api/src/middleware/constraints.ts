import type { MiddlewareHandler } from 'hono';
import type { XaaResourceContext } from '@xaa/resource-guard';
import type { createPaymentRepository } from '../store/payments.js';

type Env = { Variables: { xaa: XaaResourceContext } };

/**
 * specs §5.2, the second of the two constraint checks. The Tool Executor checks
 * `max_amount` before it calls out; this one runs even when the API is reached
 * directly, so bypassing the Executor buys nothing.
 *
 * The server-wide ceiling is unconditional: a token with no `xaa_constraints` is not
 * an unlimited token. Both checks run before the state transition, so a rejected
 * approval never has to be rolled back.
 */
export function createConstraintCheck(options: {
  repository: ReturnType<typeof createPaymentRepository>;
  absoluteMaxAmount: number;
}): MiddlewareHandler<Env> {
  return async (context, next) => {
    const paymentId = context.req.param('id');
    if (!paymentId) return next();
    const payment = await options.repository.get(paymentId, context.get('xaa').humanSubject);
    if (!payment) return next();

    const tokenLimit = (context.get('xaa').constraints as { max_amount?: unknown }).max_amount;
    if (typeof tokenLimit === 'number' && payment.amount > tokenLimit) {
      return context.json({ error: 'constraint_violation', limit_source: 'token' }, 403);
    }
    if (payment.amount > options.absoluteMaxAmount) {
      return context.json({ error: 'constraint_violation', limit_source: 'server' }, 403);
    }
    await next();
  };
}
