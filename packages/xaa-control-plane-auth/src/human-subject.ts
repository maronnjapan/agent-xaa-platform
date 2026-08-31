import type { MiddlewareHandler } from 'hono';
import type { ControlPlaneVariables } from './types.js';
import { emitProtocolValidation, type ProtocolValidationEmitter } from './protocol-validation.js';

type Env = { Variables: ControlPlaneVariables };
export interface HumanSubjectOptions { protocolValidation?: ProtocolValidationEmitter }

export function humanSubjectMiddleware(options: HumanSubjectOptions = {}): MiddlewareHandler<Env> {
  return async (context, next) => {
    const body = context.req.method === 'GET' || context.req.method === 'HEAD' ? {} : await context.req.json<Record<string, unknown>>().catch(() => ({}));
    const subject = context.get('accessToken').sub;
    if (body.human_subject !== undefined && body.human_subject !== subject) {
      emitProtocolValidation(options.protocolValidation, context, 'human_subject_mismatch', 'denied', 'human_subject_mismatch');
      return context.json({ error: 'human_subject_mismatch' }, 403);
    }
    const validatedBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'human_subject'));
    context.set('humanSubject', subject);
    context.set('validatedBody', validatedBody);
    await next();
  };
}
