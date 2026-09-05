import { Hono } from 'hono';
import {
  adminConsoleAuth, controlPlaneAuth, createProtocolValidationEmitter,
  type AdminConsoleVariables, type ControlPlaneVariables,
} from '@xaa/control-plane-auth';
import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';
import { createLogger, type Logger } from '@xaa/logging';
import type { AuthorizationConfig } from './config.js';
import { createAuthorizationStore } from './store/authorization-store.js';
import { createAdminPermissionRoutes } from './routes/admin-permissions.js';
import { createDecisionRoute } from './routes/decisions.js';
import { createPermissionChangedRoute } from './routes/permission-changed.js';
import type { VertexClient } from './ai/authorization-ai.js';
import type { DecideDeps, DecisionStep } from './pipeline/decide.js';
import type { ReprovisionClient } from './reevaluate/reprovision-client.js';

type Env = { Variables: ControlPlaneVariables & AdminConsoleVariables['Variables'] };

export interface AuthorizationDeps {
  config: AuthorizationConfig;
  documents: DocumentStore;
  vertex: VertexClient;
  jtiStore?: JtiStore;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  clock?: { now(): number };
  publishActivity?: (event: Record<string, unknown>) => Promise<void>;
  recordStep?: (step: DecisionStep) => void;
  /** Called when a permission change narrows what an agent may do (RULE-14). */
  requestReprovision?: ReprovisionClient;
  /** Test seam: resolves an admin console bearer token to the account it names. */
  verifyAdmin?(token: string, audience: string): Promise<string | null>;
}

/**
 * The Authorization Platform. It decides what an agent may do, and it is the only
 * service that does.
 *
 * The decision surface is four entries and only one of them is a GET: exposing the
 * taxonomy or the tool catalogue there would put the material for deciding permissions
 * into Automation App's hands (RULE-07).
 *
 * The permission console under `/admin` is the deliberate exception, and it is an
 * exception to the reader rather than to the rule: it is reached with a Google-signed
 * token for an account named in `ADMIN_PRINCIPALS`, which the Automation App's service
 * account is not, so RULE-07 still holds for every caller it was written about.
 */
function createApp(deps: AuthorizationDeps): Hono {
  const logger = deps.logger ?? createLogger('authorization', 'policy_engine');
  const store = createAuthorizationStore(deps.documents);
  const clock = deps.clock ?? { now: () => Date.now() };
  const publish = deps.publishActivity;

  const decideDeps: DecideDeps & { maxLifetimeHours: number } = {
    store, vertex: deps.vertex, clock, logger,
    modelVersion: deps.config.vertexModel,
    taxonomyVersion: deps.config.taxonomyVersion,
    maxLifetimeHours: Math.floor(deps.config.agentMaxLifetimeSeconds / 3600),
    ...(publish ? { publishActivity: async (event) => { await publish({ ...event }); } } : {}),
    ...(deps.recordStep ? { recordStep: deps.recordStep } : {}),
    onWarning: (warning) => logger.warning('authz_ai.warning', logContext(), { ...warning }),
  };

  const app = new Hono<Env>();
  app.get('/livez', (context) => context.json({ status: 'ok', app: 'authorization' }));

  const protect = controlPlaneAuth({
    issuer: deps.config.issuer,
    jwksUrl: deps.config.jwksUrl,
    audience: deps.config.authzAudience,
    requiredScope: 'workdef:submit',
    jtiStore: deps.jtiStore ?? new InMemoryJtiStore(() => clock.now()),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    now: () => clock.now(),
    iatSkewSeconds: deps.config.dpopIatSkewSeconds,
    // The proof's htu is built from the app's own public base URL, never from the
    // Host header, so a forwarded request cannot choose what the proof must match.
    expectedHtu: (request) => `${deps.config.authzPublicBaseUrl}${new URL(request.url).pathname}`,
    // The eight refusals are evidence, and evidence nobody writes down is not evidence.
    protocolValidation: createProtocolValidationEmitter({ logger, path: 'authorization:/api' }),
  });

  const decisions = createDecisionRoute(decideDeps);
  // /api/work-requests is the same handler under a second path, not a redirect: the
  // caller gets an identical body either way.
  for (const path of ['/v1/authorization/decisions', '/api/work-requests']) {
    app.use(path, protect);
    app.route(path, decisions);
  }

  /**
   * The permission screens (docs 03 §2). The taxonomy and the delegation table are
   * this app's own data, so the app that decides with them is the app that edits them.
   */
  app.use('/admin/*', adminConsoleAuth({
    audience: deps.config.authzPublicBaseUrl,
    allowedPrincipals: deps.config.adminPrincipals,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.verifyAdmin ? { verify: deps.verifyAdmin } : {}),
    onRefusal: (reason) => logger.warning('admin.refused', logContext(), { reason }),
  }));
  app.route('/admin', createAdminPermissionRoutes({ documents: deps.documents, logger }));

  // Pub/Sub push is authenticated by the platform (run.invoker plus the pusher's OIDC
  // token), so the human-facing DPoP chain does not apply here.
  app.route('/internal/events/human-permission-changed', createPermissionChangedRoute({
    store, logger, clock,
    ...(publish ? { publish: async (event) => { await publish({ ...event }); } } : {}),
    ...(deps.requestReprovision ? { requestReprovision: deps.requestReprovision } : {}),
  }));

  return app as unknown as Hono;
}

function logContext() {
  return { request_id: '', trace_id: '', agent_id: null, human_subject: null };
}

export default createApp;
