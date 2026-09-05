import { Hono, type Context } from 'hono';
import { FINANCE_SCOPES, TOOL_IDS } from '@xaa/contracts';
import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import { createLogger, type Logger } from '@xaa/logging';
import type { DocumentStore } from '@xaa/gcp';
import {
  createInternalRevokeRoute, createResourceProtection, createRevocationLedger, logApiAccess,
  type RevocationLedger, type ServiceIdentityVerifier, type XaaResourceContext,
} from '@xaa/resource-guard';
import { createPaymentRepository } from './store/payments.js';
import { createPaymentRoutes, PAYMENT_OPERATIONS } from './routes/payments.js';
import { requireFullIsolation } from './middleware/isolation.js';
import { createConstraintCheck } from './middleware/constraints.js';

type Env = { Variables: { xaa: XaaResourceContext } };

export interface FinanceApiDeps {
  documents: DocumentStore;
  asIssuer: string;
  resourceUri: string;
  jwksUrl: string;
  jtiStore?: JtiStore;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  serviceIdentity?: ServiceIdentityVerifier;
  lifecycleServiceAccount?: string;
  /** Injectable so a caller and this app agree on one ledger instance. */
  revocationLedger?: RevocationLedger;
  /** Terraform's finance_absolute_max_amount; always enforced (specs §5.2). */
  absoluteMaxAmount: number;
}

/** Approval needs `finance.tx.write`; reads need `finance.tx.read` (specs §5.2). */
function requiredScopes(context: { req: { method: string } }): string[] {
  return [context.req.method === 'GET' ? FINANCE_SCOPES[0] : FINANCE_SCOPES[1]];
}

function createApp(deps: FinanceApiDeps): Hono {
  const logger = deps.logger ?? createLogger('resource-finance-api', 'resource_api');
  const repository = createPaymentRepository(deps.documents, deps.now);
  const ledger = deps.revocationLedger ?? createRevocationLedger(deps.documents, deps.now);

  const app = new Hono<Env>();
  app.get('/livez', (context) => context.json({ status: 'ok' }));

  if (deps.serviceIdentity && deps.lifecycleServiceAccount) {
    app.route('/internal/revoke-by-actor', createInternalRevokeRoute({
      ledger, verifier: deps.serviceIdentity, lifecycleServiceAccount: deps.lifecycleServiceAccount,
    }));
  }

  // The access log wraps the guard so a 401 or 403 is logged with the same seven
  // fields as a success; the subject is null when the token never resolved.
  // One registration only: Hono's `/payments/*` also matches `/payments`, and a second
  // pass would consume the DPoP jti a second time and answer replay to a first call.
  app.use('/payments/*', accessLog(deps, logger));
  const protect = createResourceProtection({
    asIssuer: deps.asIssuer,
    resourceUri: deps.resourceUri,
    jwksUrl: deps.jwksUrl,
    requiredScopes,
    jtiStore: deps.jtiStore ?? new InMemoryJtiStore(deps.now),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    isRevokedActor: (actorUrn) => ledger.isActorRevoked(actorUrn),
    publicBaseUrl: deps.resourceUri,
  });
  app.use('/payments/*', protect);
  // Both gates run after the token verifies and before the state transition, so a
  // refusal never has to unwind a write.
  app.use('/payments/*', requireFullIsolation());
  app.use('/payments/:id/approve', createConstraintCheck({ repository, absoluteMaxAmount: deps.absoluteMaxAmount }));
  app.route('/payments', createPaymentRoutes(repository, logger));
  return app as unknown as Hono;
}

function accessLog(deps: FinanceApiDeps, logger: Logger) {
  return async (context: Context<Env>, next: () => Promise<void>) => {
    const startedAt = performance.now();
    await next();
    const xaa = context.get('xaa') as XaaResourceContext | undefined;
    const method = context.req.method;
    const operation = method === 'GET' && context.req.path === '/payments' ? PAYMENT_OPERATIONS.list
      : method === 'GET' ? PAYMENT_OPERATIONS.get : PAYMENT_OPERATIONS.approve;
    logApiAccess(logger, {
      request_id: '', trace_id: context.req.header('X-Cloud-Trace-Context')?.split('/')[0] ?? '',
      agent_id: xaa?.agentId ?? null, human_subject: xaa?.humanSubject ?? null,
    }, {
      // The tool id is recorded for correlation only; it never influences a decision,
      // and a value the Tool Catalog does not know is recorded as `unknown` rather
      // than echoed, so the log column stays a closed set.
      tool_id: knownToolId(context.req.header('X-XAA-Tool-Id')),
      operation, method, resource: deps.resourceUri,
      status: context.res.status,
      outcome: context.res.status < 400 ? 'success' : `error:${errorCodeOf(context.res.status)}`,
      latency_ms: performance.now() - startedAt,
      human_subject: xaa?.humanSubject ?? null,
      agent_id: xaa?.agentId ?? null,
    });
  };
}

function knownToolId(value: string | undefined): string {
  return value !== undefined && (TOOL_IDS as readonly string[]).includes(value) ? value : 'unknown';
}

function errorCodeOf(status: number): string {
  return status === 403 ? 'insufficient_scope' : status === 401 ? 'invalid_token' : status === 404 ? 'not_found' : status === 409 ? 'invalid_state' : 'invalid_request';
}

export default createApp;
