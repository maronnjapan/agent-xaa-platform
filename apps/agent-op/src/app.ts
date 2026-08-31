import { Hono } from 'hono';
import type { AgentOpDeps } from './deps.js';
import { clientAssertionMiddleware } from './middleware/client-assertion.js';
import { dpopMiddleware } from './middleware/dpop.js';
import { healthzApp } from './routes/healthz.js';
import { createXaaTokenRoute } from './routes/xaa-token.js';
import { createSubjectTokenRoute } from './routes/xaa-subject-token.js';
import { createXaaCallbackRoute } from './routes/xaa-callback.js';
import { createInternalRevokeRoute, type ServiceIdentityVerifier } from './routes/internal-revoke-connection.js';
import { createAgentOpStore } from './store/index.js';
import { emitProtocolViolationEvent, type AgentOpViolationCode } from './log/protocol-violation-event.js';

export interface AgentOpAppDeps extends AgentOpDeps {
  automationAppUrl?: string;
  serviceIdentity?: ServiceIdentityVerifier;
  lifecycleServiceAccount?: string;
}

/**
 * REQ-08-015 / DEC-IAC-14. Cloud Run sets ingress per service, so /xaa/token must be
 * internal while /xaa/callback is public. One image, two services, chosen by MODE.
 *
 * No /authorize, /userinfo, /introspect, /revoke or discovery handler exists here
 * (DEC-ID-03); those paths fall through to Hono's own 404 rather than being listed
 * in an explicit deny.
 */
function createApp(deps: AgentOpAppDeps): Hono {
  const app = new Hono();
  app.route('/healthz', healthzApp);

  if (deps.config.mode === 'token') {
    const store = createAgentOpStore(deps.documents, deps.config, () => deps.signer.kid);
    app.use('/xaa/token', violationContext(deps), clientAssertion(deps, store), dpop(deps));
    app.use('/xaa/subject-token', violationContext(deps), clientAssertion(deps, store), dpop(deps));
    app.route('/xaa/token', createXaaTokenRoute(deps));
    app.route('/xaa/subject-token', createSubjectTokenRoute(deps));
    if (deps.serviceIdentity && deps.lifecycleServiceAccount) {
      app.route('/internal/revoke-connection', createInternalRevokeRoute(deps, deps.serviceIdentity, deps.lifecycleServiceAccount));
    }
  } else {
    app.route('/xaa/callback', createXaaCallbackRoute(deps, deps.automationAppUrl ?? ''));
  }
  return app;
}

function clientAssertion(deps: AgentOpDeps, store: ReturnType<typeof createAgentOpStore>) {
  return clientAssertionMiddleware({
    issuer: deps.config.issuer, registrations: store.registrations,
    jtiStore: deps.jtiStore, ...(deps.now ? { now: deps.now } : {}),
  });
}

function dpop(deps: AgentOpDeps) {
  return dpopMiddleware({
    publicBaseUrl: deps.config.publicBaseUrl, jtiStore: deps.jtiStore,
    ...(deps.now ? { now: deps.now } : {}),
  });
}

/** Gives the DPoP layer a way to raise an Activity Event without importing Pub/Sub. */
function violationContext(deps: AgentOpDeps) {
  return async (context: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
    context.set('emitViolation', (code: AgentOpViolationCode, detail: { agent_id: string | null }) => {
      void emitProtocolViolationEvent(deps.publisher, {
        violation_code: code, agent_id: detail.agent_id, human_subject: null,
        ...(deps.now ? { now: deps.now } : {}),
      });
    });
    await next();
  };
}

export default createApp;
