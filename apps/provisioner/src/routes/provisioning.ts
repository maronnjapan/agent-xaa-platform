import { Hono } from 'hono';
import { PLATFORM_CLIENT_ID, type IsolationLevel } from '@xaa/contracts';
import type { ControlPlaneVariables } from '@xaa/control-plane-auth';
import type { Logger } from '@xaa/logging';
import { HARD_CAP_SECONDS } from '../agent/expiry.js';
import type { CatalogRepository } from '../catalog/repository.js';
import { provisionAgent } from '../provisioning/flow.js';
import { validateAgentDefinition, DefinitionRejected } from './agent-definition.js';
import type { ProvisionerDeps } from '../deps.js';

type Env = { Variables: ControlPlaneVariables };

export interface DecisionRecord {
  decision_id: string;
  human_subject: string;
  effective_capabilities: string[];
  security_profile: { isolation_level: IsolationLevel };
  constraints: Record<string, Record<string, unknown>>;
}

/**
 * `POST /provisioning`. Turns an approved decision into a running agent.
 *
 * Nothing is written until every check has passed (RULE-43, RULE-44): the token, the
 * proof, the body shape, the decision's ownership and the capability subset are all
 * settled before the first Firestore write, so a rejected request leaves no trace to
 * clean up. What happens after that is the eleven steps, and they live in the flow this
 * route shares with re-provisioning (T-PROV-28).
 */
export function createProvisioningRoute(deps: ProvisionerDeps & { catalogue: CatalogRepository; logger: Logger }): Hono<Env> {
  const app = new Hono<Env>();

  app.post('/', async (context) => {
    const humanSubject = context.get('humanSubject');
    let definition;
    try {
      definition = validateAgentDefinition(
        context.get('validatedBody'),
        Math.floor(Math.min(deps.config.agentMaxLifetimeSeconds, HARD_CAP_SECONDS) / 60),
      );
    } catch (error) {
      if (error instanceof DefinitionRejected) return context.json({ error: error.code }, 400);
      throw error;
    }

    // The decision is re-read rather than trusted from the body, and its owner must
    // be the caller: a decision id is not a bearer token.
    const decision = await deps.documents.get<DecisionRecord>('authorization_decisions', definition.decision_id);
    if (!decision) return context.json({ error: 'decision_mismatch' }, 400);
    if (decision.human_subject !== humanSubject) return context.json({ error: 'decision_owner_mismatch' }, 403);

    const outcome = await provisionAgent(deps, {
      humanSubject,
      taskId: definition.task_id,
      effectiveCapabilities: decision.effective_capabilities,
      isolationLevel: decision.security_profile.isolation_level,
      constraints: decision.constraints ?? {},
      lifetime: { kind: 'requested', minutes: definition.requested_lifetime_minutes },
    });
    return context.json(outcome.body, outcome.status, outcome.headers ?? {});
  });

  return app;
}

export { PLATFORM_CLIENT_ID };
