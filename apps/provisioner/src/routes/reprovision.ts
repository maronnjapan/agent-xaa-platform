import { Hono } from 'hono';
import { compile, INITIAL_TASK_ID, SchemaValidationError, type IsolationLevel } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';
import type { CatalogRepository } from '../catalog/repository.js';
import { requireInternalCaller } from '../middleware/internal-caller.js';
import { provisionAgent } from '../provisioning/flow.js';
import type { ProvisionerDeps } from '../deps.js';

/**
 * The body Lifecycle sends (00b §4). It names no decision: the decision that authorised
 * the original agent is gone with it, and Lifecycle has already checked that the
 * narrowed capabilities still cover the work (T-LIFE-13). What it may not do is widen
 * them, which is why they are re-checked against `human_permissions` in the flow.
 */
export const reprovisionBodySchema = {
  $id: 'reprovision-body',
  type: 'object',
  additionalProperties: false,
  required: [
    'work_definition_id', 'human_subject', 'effective_capabilities',
    'isolation_level', 'inherited_expires_at', 'previous_agent_id',
  ],
  properties: {
    work_definition_id: { type: 'string', minLength: 1, maxLength: 128 },
    human_subject: { type: 'string', minLength: 1 },
    effective_capabilities: { type: 'array', items: { type: 'string' }, minItems: 1 },
    isolation_level: { enum: ['standard', 'full_isolation'] },
    inherited_expires_at: { type: 'string', format: 'date-time' },
    previous_agent_id: { type: 'string', pattern: '^agent-[0-9a-z]{26}$' },
  },
} as const;

export interface ReprovisionBody {
  work_definition_id: string;
  human_subject: string;
  effective_capabilities: string[];
  isolation_level: IsolationLevel;
  inherited_expires_at: string;
  previous_agent_id: string;
}

const assertBody: (value: unknown) => asserts value is ReprovisionBody = compile<ReprovisionBody>(reprovisionBodySchema);

/**
 * `POST /internal/provisioning/reprovision`. The replacement agent for one whose
 * permissions changed (RULE-29).
 *
 * There is no Access Token here and no DPoP proof: the caller is `sa-lifecycle` acting
 * on its own behalf, not a person, so the only credential that makes sense is the
 * Google-issued ID Token Cloud Run gives it. The human subject therefore comes from the
 * body — and is the one thing this route cannot verify, which is why the flow re-reads
 * that person's permissions rather than trusting the capability list it was handed.
 *
 * The expiry is inherited, never recalculated: a permission change must not extend an
 * agent's life.
 */
export function createReprovisionRoute(
  deps: ProvisionerDeps & { catalogue: CatalogRepository; logger: Logger },
): Hono {
  const app = new Hono();

  app.use('/reprovision', requireInternalCaller({
    audience: new URL(deps.config.publicBaseUrl).origin,
    allowedCallers: deps.config.internalCallers,
    ...(deps.verifyInternalCaller ? { verify: deps.verifyInternalCaller } : {}),
  }));

  app.post('/reprovision', async (context) => {
    const body: unknown = await context.req.json().catch(() => undefined);
    try {
      assertBody(body);
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      return context.json({ error: 'invalid_request' }, 400);
    }

    const outcome = await provisionAgent(deps, {
      humanSubject: body.human_subject,
      // The replacement is a fresh Execution, so it reports under the same id a first
      // Execution does. The work definition id was used here, and it is not one of the
      // four shapes the timeline groups by (docs 11 §3.3) — the events reached the
      // store and were then dropped on the way to the screen.
      taskId: INITIAL_TASK_ID,
      effectiveCapabilities: body.effective_capabilities,
      isolationLevel: body.isolation_level,
      constraints: {},
      lifetime: { kind: 'inherited', expiresAt: body.inherited_expires_at },
      previousAgentId: body.previous_agent_id,
    });
    return context.json(outcome.body, outcome.status, outcome.headers ?? {});
  });

  return app;
}
