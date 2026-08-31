import type { MiddlewareHandler } from 'hono';
import { accessTokenMiddleware, type AccessTokenOptions } from './access-token.js';
import { dpopMiddleware, type DpopOptions } from './dpop.js';
import { humanSubjectMiddleware, type HumanSubjectOptions } from './human-subject.js';
export * from './access-token.js';
export * from './dpop.js';
export * from './human-subject.js';
export * from './protocol-validation.js';
export * from './types.js';

export const STEP_TABLE = [
  { step: 1, validation: 'authorization_scheme', status: 401 },
  { step: 2, validation: 'access_token', status: 401 },
  { step: 3, validation: 'scope', status: 403 },
  { step: 4, validation: 'dpop_presence', status: 401 },
  { step: 5, validation: 'dpop_proof', status: 401 },
  { step: 6, validation: 'dpop_replay', status: 401 },
  { step: 7, validation: 'dpop_binding', status: 401 },
  { step: 8, validation: 'human_subject', status: 403 },
] as const;

export type ControlPlaneAuthOptions = AccessTokenOptions & DpopOptions & HumanSubjectOptions;

/**
 * Runs the steps in order, stopping at the first refusal.
 *
 * A step that refuses returns a Response, and that Response is what the caller must
 * receive — dropping it would leave the request with no answer at all. A step that
 * passes returns nothing and the next one runs.
 */
function compose(middlewares: MiddlewareHandler[]): MiddlewareHandler {
  return async (context, finalNext) => {
    let index = -1;
    const dispatch = async (position: number): Promise<Response | void> => {
      if (position <= index) throw new Error('middleware next called more than once');
      index = position;
      const middleware = middlewares[position];
      if (!middleware) return finalNext();
      let downstream: Response | undefined;
      const result = await middleware(context, async () => { downstream = (await dispatch(position + 1)) ?? undefined; });
      return result ?? downstream;
    };
    return dispatch(0);
  };
}

export function controlPlaneAuth(options: ControlPlaneAuthOptions): MiddlewareHandler {
  return compose([accessTokenMiddleware(options), dpopMiddleware(options), humanSubjectMiddleware(options)]);
}
