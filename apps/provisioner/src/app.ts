import { Hono } from 'hono';
import { controlPlaneAuth, type ControlPlaneVariables } from '@xaa/control-plane-auth';
import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import { createLogger } from '@xaa/logging';
import { createCatalogRepository } from './catalog/repository.js';
import { createProvisioningRoute } from './routes/provisioning.js';
import { createResumeRoute } from './routes/resume.js';
import type { ProvisionerDeps } from './deps.js';

type Env = { Variables: ControlPlaneVariables };

export interface ProvisionerAppDeps extends ProvisionerDeps {
  jtiStore?: JtiStore;
  fetchImpl?: typeof fetch;
}

/**
 * The Agent Provisioner. It creates Firestore records and asks Cloud Run to start a
 * job; for a FULL_ISOLATION agent it also creates that agent's own OP, keys and
 * service accounts, and records every one of them in a ledger (DEC-IAC-07).
 *
 * It is internal-only: `agent:provision` on a DPoP-bound Access Token is the sole way
 * in, and the consent URLs it returns always point somewhere else (RULE-37).
 */
function createApp(deps: ProvisionerAppDeps): Hono {
  const logger = deps.logger ?? createLogger('provisioner', 'provisioner');
  const app = new Hono<Env>();
  app.get('/healthz', (context) => context.json({ status: 'ok', app: 'provisioner' }));

  const protect = controlPlaneAuth({
    issuer: deps.config.issuer,
    jwksUrl: deps.config.jwksUrl,
    audience: deps.config.audience,
    requiredScope: 'agent:provision',
    jtiStore: deps.jtiStore ?? new InMemoryJtiStore(() => deps.clock.now()),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    now: () => deps.clock.now(),
    iatSkewSeconds: deps.config.dpopIatSkewSeconds,
    expectedHtu: (request) => `${deps.config.publicBaseUrl}${new URL(request.url).pathname}`,
  });

  // One registration: Hono's `/provisioning/*` also matches `/provisioning`, and a
  // second pass would consume the DPoP jti again and answer replay to a first call.
  app.use('/provisioning/*', protect);
  app.route('/provisioning', createProvisioningRoute({
    ...deps, logger, catalogue: createCatalogRepository(deps.documents),
  }));
  app.route('/provisioning', createResumeRoute(deps));

  app.onError((error, context) => {
    logger.error('provisioner.error', { request_id: '', trace_id: '', agent_id: null, human_subject: null }, {
      message: error.message,
      schema_id: (error as { schemaId?: string }).schemaId ?? null,
      instance_path: (error as { instancePath?: string }).instancePath ?? null,
    });
    return context.json({ error: 'internal_error' }, 500);
  });

  return app as unknown as Hono;
}

export default createApp;
