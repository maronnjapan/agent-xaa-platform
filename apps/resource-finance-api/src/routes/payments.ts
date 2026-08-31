import { Hono } from 'hono';
import { AGENT_URN_PREFIX } from '@xaa/contracts';
import type { XaaResourceContext } from '@xaa/resource-guard';
import { InvalidState, type createPaymentRepository } from '../store/payments.js';

type Env = { Variables: { xaa: XaaResourceContext } };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const PAYMENT_OPERATIONS = {
  list: 'payment.list', get: 'payment.get', approve: 'payment.approve',
} as const;

export function createPaymentRoutes(repository: ReturnType<typeof createPaymentRepository>): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/', async (context) => {
    const limit = Number(context.req.query('limit') ?? DEFAULT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return context.json({ error: 'invalid_request' }, 400);
    return context.json({
      payments: await repository.list(context.get('xaa').humanSubject, {
        ...(context.req.query('status') ? { status: context.req.query('status')! } : {}),
        limit,
      }),
    });
  });

  app.get('/:id', async (context) => {
    const payment = await repository.get(context.req.param('id'), context.get('xaa').humanSubject);
    if (!payment) return context.json({ error: 'not_found' }, 404);
    return context.json(payment);
  });

  app.post('/:id/approve', async (context) => {
    const xaa = context.get('xaa');
    try {
      const result = await repository.approve(context.req.param('id'), xaa.humanSubject, {
        approvedBy: xaa.humanSubject,
        approvedByAgent: `${AGENT_URN_PREFIX}${xaa.agentId}`,
      });
      if (result.outcome === 'not_found') return context.json({ error: 'not_found' }, 404);
      // The five keys are the same on both outcomes, and the subjects on an
      // already-approved payment are the ones recorded the first time.
      return context.json({
        payment_id: result.payment.payment_id,
        status: result.payment.status,
        approved_by: result.payment.approved_by,
        approved_by_agent: result.payment.approved_by_agent,
        approved_at: result.payment.approved_at,
        ...(result.outcome === 'already_approved' ? { result: 'already_approved' } : {}),
      });
    } catch (error) {
      if (error instanceof InvalidState) return context.json({ error: 'invalid_state' }, 409);
      throw error;
    }
  });

  return app;
}
