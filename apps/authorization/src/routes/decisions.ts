import { Hono } from 'hono';
import { compile } from '@xaa/contracts';
import type { ControlPlaneVariables } from '@xaa/control-plane-auth';
import { decide, type DecideDeps } from '../pipeline/decide.js';
import { EffectiveExceedsHumanPermissionError } from '../policy/invariant.js';
import { validateWorkRequest, WorkRequestRejected } from '../validation/work-request.js';
import { authorizationDecisionResponseSchema, DECISION_RESPONSE_KEYS } from './index.js';

type Env = { Variables: ControlPlaneVariables };

interface DecisionResponse { decision_id: string; status: string; effective_capabilities: string[]; security_profile: unknown; denied: unknown[] }
const assertResponse: (value: unknown) => asserts value is DecisionResponse = compile<DecisionResponse>(authorizationDecisionResponseSchema);

export function createDecisionRoute(deps: DecideDeps & { maxLifetimeMinutes: number }): Hono<Env> {
  const app = new Hono<Env>();
  app.post('/', async (context) => {
    let request;
    try {
      request = validateWorkRequest(context.get('validatedBody'), deps.maxLifetimeMinutes);
    } catch (error) {
      if (error instanceof WorkRequestRejected) return context.json({ error: error.code }, 400);
      throw error;
    }

    try {
      // The subject always comes from the verified Access Token. A `human_subject` in
      // the body was already refused by the human-subject middleware when it
      // disagreed, and it is not read here in any case.
      const record = await decide({
        humanSubject: context.get('humanSubject'),
        purpose: request.purpose,
        description: request.description,
        constraints: request.constraints ?? {},
        requestedLifetimeMinutes: request.requested_lifetime_minutes,
      }, deps);

      const response = {
        decision_id: record.decision_id,
        status: record.status,
        effective_capabilities: record.effective_capabilities,
        security_profile: record.security_profile,
        denied: record.denied,
      };
      // Validated before it leaves: a response that does not match the contract is an
      // internal error, not something to send and let the caller puzzle over.
      assertResponse(response);
      return context.json(response);
    } catch (error) {
      if (error instanceof EffectiveExceedsHumanPermissionError) return context.json({ error: 'internal_error' }, 500);
      return context.json({ error: 'internal_error' }, 500);
    }
  });
  return app;
}

export { DECISION_RESPONSE_KEYS };
