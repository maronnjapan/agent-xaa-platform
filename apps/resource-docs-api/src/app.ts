import { Hono, type Context } from 'hono';
import { DOCS_SCOPES } from '@xaa/contracts';
import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import { createLogger, type Logger } from '@xaa/logging';
import type { DocumentStore } from '@xaa/gcp';
import {
  createInternalDocumentWriter, createInternalRevokeRoute, createResourceProtection, createRevocationLedger, logApiAccess,
  type RevocationLedger, type ServiceIdentityVerifier, type XaaResourceContext,
} from '@xaa/resource-guard';
import { createDocumentRepository } from './store/documents.js';
import { createDocumentRoutes, DOCUMENT_OPERATIONS } from './routes/documents.js';

type Env = { Variables: { xaa: XaaResourceContext } };

export interface DocsApiDeps {
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
  /** T-APP-05: the only other caller ever let past `serviceIdentity`. */
  automationAppServiceAccount?: string;
  /** Injectable so a caller and this app agree on one ledger instance. */
  revocationLedger?: RevocationLedger;
}

/** A write needs `docs.write`; everything else needs `docs.read` (specs §5.1). */
function requiredScopes(context: { req: { method: string } }): string[] {
  return [context.req.method === 'GET' ? DOCS_SCOPES[0] : DOCS_SCOPES[1]];
}

function createApp(deps: DocsApiDeps): Hono {
  const logger = deps.logger ?? createLogger('resource-docs-api', 'resource_api');
  const repository = createDocumentRepository(deps.documents, deps.now);
  const ledger = deps.revocationLedger ?? createRevocationLedger(deps.documents, deps.now);

  const app = new Hono<Env>();
  app.get('/healthz', (context) => context.json({ status: 'ok' }));

  if (deps.serviceIdentity && deps.lifecycleServiceAccount) {
    app.route('/internal/revoke-by-actor', createInternalRevokeRoute({
      ledger, verifier: deps.serviceIdentity, lifecycleServiceAccount: deps.lifecycleServiceAccount,
    }));
  }

  // The access log wraps the guard so a 401 or 403 is logged with the same seven
  // fields as a success; the subject is null when the token never resolved.
  // One registration only: Hono's `/documents/*` also matches `/documents`, and a second
  // pass would consume the DPoP jti a second time and answer replay to a first call.
  app.use('/documents/*', accessLog(deps, logger));
  // T-APP-05: the Automation App writes the daily report before any agent exists to
  // delegate through, so it calls in with its own Cloud Run service identity rather
  // than a DPoP-bound XAA Access Token. This middleware only ever answers a `POST`
  // at the exact `/documents` path with `type: 'daily_report'` from the configured
  // service account; every other request — including any GET — falls through
  // untouched to `protect` below, which is where the XAA protection stays intact.
  if (deps.serviceIdentity && deps.automationAppServiceAccount) {
    app.use('/documents/*', createInternalDocumentWriter({
      verifier: deps.serviceIdentity,
      automationAppServiceAccount: deps.automationAppServiceAccount,
      create: (input) => repository.create({
        ownerSubject: input.humanSubject, type: 'daily_report',
        title: input.title, body: input.body, occurredAt: input.occurredAt,
      }),
    }));
  }
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
  app.use('/documents/*', protect);
  app.route('/documents', createDocumentRoutes(repository));
  return app as unknown as Hono;
}

function accessLog(deps: DocsApiDeps, logger: Logger) {
  return async (context: Context<Env>, next: () => Promise<void>) => {
    const startedAt = performance.now();
    await next();
    const xaa = context.get('xaa') as XaaResourceContext | undefined;
    const method = context.req.method;
    const operation = method === 'GET' && context.req.path === '/documents' ? DOCUMENT_OPERATIONS.list
      : method === 'GET' ? DOCUMENT_OPERATIONS.get
      : method === 'POST' ? DOCUMENT_OPERATIONS.create : DOCUMENT_OPERATIONS.update;
    logApiAccess(logger, {
      request_id: '', trace_id: context.req.header('X-Cloud-Trace-Context')?.split('/')[0] ?? '',
      agent_id: xaa?.agentId ?? null, human_subject: xaa?.humanSubject ?? null,
    }, {
      // The tool id is recorded for correlation only; it never influences a decision.
      tool_id: context.req.header('X-XAA-Tool-Id') ?? 'unknown',
      operation, method, resource: deps.resourceUri,
      status: context.res.status,
      outcome: context.res.status < 400 ? 'success' : `error:${errorCodeOf(context.res.status)}`,
      latency_ms: performance.now() - startedAt,
      human_subject: xaa?.humanSubject ?? null,
      agent_id: xaa?.agentId ?? null,
    });
  };
}

function errorCodeOf(status: number): string {
  return status === 403 ? 'insufficient_scope' : status === 401 ? 'invalid_token' : status === 404 ? 'not_found' : status === 409 ? 'version_conflict' : 'invalid_request';
}

export default createApp;
