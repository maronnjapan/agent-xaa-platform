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
      // The caller is told `internal_error` either way — the invariant breach and an
      // unexpected throw are the same thing to the person waiting on a decision, and
      // naming which one it was would describe this platform's internals over the wire.
      //
      // It is written down here, though, and that is the change. This catch used to
      // swallow the error whole: Automation App reports every answer that is not a 400
      // as 「権限を判定する仕組みに届きませんでした」, so a decision that threw left the
      // screen saying the platform was unreachable and left no record anywhere of what
      // actually threw.
      deps.logger?.error('decision_failed', {
        request_id: '', trace_id: '', agent_id: null, human_subject: context.get('humanSubject'),
      }, {
        reason: error instanceof EffectiveExceedsHumanPermissionError ? 'effective_exceeds_human_permission' : 'unexpected_error',
        error: String(error),
      });
      return context.json({ error: 'internal_error' }, 500);
    }
  });
  return app;
}

export { DECISION_RESPONSE_KEYS };
