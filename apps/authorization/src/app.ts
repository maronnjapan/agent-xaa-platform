import { Hono } from 'hono';
import { controlPlaneAuth, type ControlPlaneVariables } from '@xaa/control-plane-auth';
import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';
import { createLogger, type Logger } from '@xaa/logging';
import type { AuthorizationConfig } from './config.js';
import { createAuthorizationStore } from './store/authorization-store.js';
import { createDecisionRoute } from './routes/decisions.js';
import { createPermissionChangedRoute } from './routes/permission-changed.js';
import type { VertexClient } from './ai/authorization-ai.js';
import type { DecideDeps, DecisionStep } from './pipeline/decide.js';

type Env = { Variables: ControlPlaneVariables };

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
  /** Called when a permission change requires Lifecycle to re-provision. */
  requestReprovision?: (agentId: string, reason: string) => Promise<void>;
}

/**
 * The Authorization Platform. It decides what an agent may do, and it is the only
 * service that does.
 *
 * The route surface is four entries and only one of them is a GET: exposing the
 * taxonomy or the tool catalogue over HTTP would put the material for deciding
 * permissions into Automation App's hands (RULE-07).
 */
function createApp(deps: AuthorizationDeps): Hono {
  const logger = deps.logger ?? createLogger('authorization', 'policy_engine');
  const store = createAuthorizationStore(deps.documents);
  const clock = deps.clock ?? { now: () => Date.now() };

  const decideDeps: DecideDeps & { maxLifetimeHours: number } = {
    store, vertex: deps.vertex, clock,
    maxLifetimeHours: Math.floor(deps.config.agentMaxLifetimeSeconds / 3600),
    ...(deps.publishActivity ? { publishActivity: deps.publishActivity } : {}),
    ...(deps.recordStep ? { recordStep: deps.recordStep } : {}),
    onWarning: (warning) => logger.warning('authz_ai.warning', logContext(), { ...warning }),
  };

  const app = new Hono<Env>();
  app.get('/healthz', (context) => context.json({ status: 'ok', app: 'authorization' }));

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
  });

  const decisions = createDecisionRoute(decideDeps);
  // /api/work-requests is the same handler under a second path, not a redirect: the
  // caller gets an identical body either way.
  for (const path of ['/v1/authorization/decisions', '/api/work-requests']) {
    app.use(path, protect);
    app.route(path, decisions);
  }

  // Pub/Sub push is authenticated by the platform (run.invoker plus the pusher's OIDC
  // token), so the human-facing DPoP chain does not apply here.
  app.route('/internal/events/human-permission-changed', createPermissionChangedRoute({
    store, logger, clock,
    ...(deps.requestReprovision ? { requestReprovision: deps.requestReprovision } : {}),
  }));

  return app as unknown as Hono;
}

function logContext() {
  return { request_id: '', trace_id: '', agent_id: null, human_subject: null };
}

export default createApp;
