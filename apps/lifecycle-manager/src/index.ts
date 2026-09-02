import { Hono } from 'hono';
import { controlPlaneAuth, createProtocolValidationEmitter, type ControlPlaneVariables } from '@xaa/control-plane-auth';
import { compile } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { createLogger, type LogContext, type Logger } from '@xaa/logging';
import type { LifecycleConfig, CleanupReason } from './config.js';
import { CLEANUP_REASONS } from './config.js';
import { cleanupAgent, type CleanupDeps } from './cleanup/index.js';
import type { CleanupOutcome } from './cleanup/result.js';
import type { CleanupClients } from './clients/types.js';
import { assertAgentOwnership, ForbiddenSubject } from './ownership.js';
import { AgentNotFound, writeStatus } from './status-writer.js';
import { InvalidTransitionError, type AgentStatus } from './state-machine.js';
import { requireInternalCaller, type InternalOidcOptions } from './middleware/internal-oidc.js';
import { quarantine } from './quarantine.js';
import { sweep, type SweepDeps } from './sweep.js';
import { emitLifecycleEvent, eventTypeFor } from './events.js';
import { loadDomain } from './domain.js';
import { agentOpUrlFor } from './clients/op-target.js';
import { reprovision } from './reprovision.js';
import type { ProvisionerClient } from './clients/types.js';

const transitionSchema = {
  $id: 'lifecycle-transition',
  type: 'object',
  additionalProperties: false,
  required: ['to', 'reason'],
  properties: {
    to: { enum: ['CREATED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED'] },
    severity: { const: 'CRITICAL' },
    finding_id: { type: 'string' },
    reason: { enum: CLEANUP_REASONS },
  },
} as const;

interface TransitionBody { to: AgentStatus; severity?: 'CRITICAL'; finding_id?: string; reason: CleanupReason }
const assertTransition: (value: unknown) => asserts value is TransitionBody = compile<TransitionBody>(transitionSchema);

export interface LifecycleDeps {
  config: LifecycleConfig;
  /** Test seam: how the Access Token guard fetches the issuer's JWK Set. */
  fetchImpl?: typeof fetch;
  documents: DocumentStore;
  clients: CleanupClients;
  provisioner: ProvisionerClient;
  provisionerUrl: string;
  accessToken: Parameters<typeof controlPlaneAuth>[0];
  internalAuth: InternalOidcOptions;
  logger?: Logger;
  now?: () => number;
  auditWrite?: (line: string) => void;
  publishActivity?: Parameters<typeof emitLifecycleEvent>[0]['publish'];
  sweepExtras?: Pick<SweepDeps, 'listLabelledResources' | 'deleteResource'>;
}

type Env = { Variables: ControlPlaneVariables & { callerEmail: string } };

/**
 * The one way in and out of an agent's life.
 *
 * Five routes: one a person can reach, and four that only the platform can. The public
 * one accepts no body at all — the subject comes from the verified token, never from
 * what was sent (RULE-43) — and every internal one is gated on a named service account.
 */
const logContext = (agentId: string | null): LogContext => ({
  request_id: 'lifecycle', trace_id: 'lifecycle', agent_id: agentId, human_subject: null,
});

function cleanupDepsFor(deps: LifecycleDeps, logger: Logger, now: () => number, agentId: string): CleanupDeps {
  return {
    documents: deps.documents, clients: deps.clients, logger, logContext: logContext(agentId), now,
    onDestroyed: async (domain, reason) => {
      const eventType = eventTypeFor(reason);
      if (!eventType) return;
      await emitLifecycleEvent({
        eventType, agentId: domain.agent_id, humanSubject: domain.human_subject,
        traceId: `lifecycle-${domain.agent_id}`, occurredAt: new Date(now()).toISOString(),
        ...(deps.publishActivity ? { publish: deps.publishActivity } : {}),
      });
    },
  };
}

/**
 * Cleanup as the subscriber sees it (T-LIFE-15).
 *
 * The identity feed runs outside the HTTP app but must destroy agents exactly the way
 * the routes do, down to the Activity Event, so both take this one function rather than
 * each assembling its own dependencies.
 */
export function createCleanupRunner(deps: LifecycleDeps): (agentId: string, reason: CleanupReason) => Promise<CleanupOutcome> {
  const logger = deps.logger ?? createLogger('lifecycle-manager', 'provisioner');
  const now = deps.now ?? (() => Date.now());
  return (agentId, reason) => cleanupAgent(agentId, reason, cleanupDepsFor(deps, logger, now, agentId));
}

function createApp(deps: LifecycleDeps): Hono<Env> {
  const app = new Hono<Env>();
  const logger = deps.logger ?? createLogger('lifecycle-manager', 'provisioner');
  const now = deps.now ?? (() => Date.now());

  const cleanupDeps = (agentId: string): CleanupDeps => cleanupDepsFor(deps, logger, now, agentId);
  const runCleanup = (agentId: string, reason: CleanupReason) => cleanupAgent(agentId, reason, cleanupDeps(agentId));

  app.get('/healthz', (context) => context.json({ status: 'ok' }));

  /**
   * The stop button. Checks are ordered so the answer never depends on state the caller
   * is not entitled to see: existence, then ownership, then status.
   */
  app.post('/agents/:agent_id/revoke', controlPlaneAuth({
    ...deps.accessToken,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    protocolValidation: createProtocolValidationEmitter({ logger, path: 'lifecycle:/agents' }),
  }), async (context) => {
    const agentId = context.req.param('agent_id');
    const subject = context.get('humanSubject');
    try {
      const owned = await assertAgentOwnership({ documents: deps.documents, agentId, subject });
      audit({ operation: 'agent.revoke', agentId, actor: subject, result: 'accepted' });
      if (owned.status === 'DESTROYED') return context.json({ status: 'DESTROYED' }, 200);
      await writeStatus({ documents: deps.documents, agentId, to: 'REVOKED', reason: 'USER_STOP', now: now() })
        .catch((error) => { if (!(error instanceof InvalidTransitionError)) throw error; });
      // Answered before cleanup finishes: a Cloud Run request must not have to outlive
      // eleven steps, and the sweep retries whatever did not complete.
      void runCleanup(agentId, 'USER_STOP').catch(() => undefined);
      return context.json({ status: 'REVOKED', cleanup: 'started' }, 202);
    } catch (error) {
      if (error instanceof AgentNotFound) {
        audit({ operation: 'agent.revoke', agentId, actor: subject, result: 'denied', denial_reason: 'agent_not_found' });
        return context.json({ error: 'agent_not_found' }, 404);
      }
      if (error instanceof ForbiddenSubject) {
        audit({ operation: 'agent.revoke', agentId, actor: subject, result: 'denied', denial_reason: 'forbidden_subject' });
        return context.json({ error: 'forbidden_subject' }, 403);
      }
      throw error;
    }
  });

  app.post('/internal/tick', requireInternalCaller(deps.internalAuth), async (context) => {
    const counters = await sweep({
      documents: deps.documents,
      expiringWindowSeconds: deps.config.expiringWindowSeconds,
      now,
      cleanup: runCleanup,
      ...(deps.sweepExtras ?? {}),
    });
    return context.json(counters, 200);
  });

  app.post('/internal/agents/:agent_id/transition', requireInternalCaller(deps.internalAuth), async (context) => {
    const agentId = context.req.param('agent_id');
    const body = await context.req.json().catch(() => undefined);
    try {
      assertTransition(body);
    } catch {
      return context.json({ error: 'invalid_request' }, 400);
    }
    try {
      if (body.to === 'QUARANTINED') {
        const domain = await loadDomain(deps.documents, agentId);
        await quarantine({
          documents: deps.documents, clients: deps.clients, agentId,
          bridgeBindingIds: domain.bridge_binding_ids,
          opBaseUrl: agentOpUrlFor(domain, deps.clients),
          ...(body.severity ? { severity: body.severity } : {}), now: now(),
        });
        return context.json({ from: domain.status, to: 'QUARANTINED' }, 202);
      }
      if (body.to === 'REVOKED') {
        const moved = await writeStatus({ documents: deps.documents, agentId, to: 'REVOKED', reason: body.reason, now: now() });
        void runCleanup(agentId, body.reason).catch(() => undefined);
        return context.json(moved, 202);
      }
      // SUSPICIOUS changes the status and nothing else: heightened attention is the
      // logs' business, not this service's.
      const moved = await writeStatus({
        documents: deps.documents, agentId, to: body.to, reason: body.reason,
        ...(body.severity ? { severity: body.severity } : {}), now: now(),
      });
      return context.json(moved, 202);
    } catch (error) {
      if (error instanceof InvalidTransitionError) return context.json({ error: 'invalid_transition' }, 409);
      if (error instanceof AgentNotFound) return context.json({ error: 'agent_not_found' }, 404);
      throw error;
    }
  });

  app.post('/internal/agents/:agent_id/reprovision', requireInternalCaller(deps.internalAuth), async (context) => {
    const agentId = context.req.param('agent_id');
    const body = await context.req.json().catch(() => ({})) as {
      effective_capabilities?: string[];
      required_capabilities?: string[];
      work_definition_id?: string;
    };
    const outcome = await reprovision({
      agentId,
      newEffectiveCapabilities: body.effective_capabilities ?? [],
      requiredCapabilities: body.required_capabilities ?? [],
      workDefinitionId: body.work_definition_id ?? '',
      documents: deps.documents,
      cleanup: cleanupDeps(agentId),
      provisioner: deps.provisioner,
      provisionerUrl: deps.provisionerUrl,
      now,
    });
    if (outcome.result === 'reprovisioned' && outcome.new_agent_id) {
      const domainSubject = await deps.documents.get<{ human_subject?: string }>('agents', `${outcome.new_agent_id}__meta`);
      await emitLifecycleEvent({
        eventType: 'RE_PROVISIONED', agentId: outcome.new_agent_id,
        humanSubject: domainSubject?.human_subject ?? 'unknown',
        traceId: `lifecycle-${outcome.new_agent_id}`, occurredAt: new Date(now()).toISOString(),
        detail: { old_agent_id: outcome.old_agent_id, new_agent_id: outcome.new_agent_id, reason: 'REPROVISION' },
        ...(deps.publishActivity ? { publish: deps.publishActivity } : {}),
      }).catch(() => undefined);
    }
    if (outcome.result === 'aborted' && outcome.reason_code === 'capability_insufficient') {
      await emitLifecycleEvent({
        eventType: 'AGENT_REPROVISION_FAILED', agentId: outcome.old_agent_id, humanSubject: 'unknown',
        traceId: `lifecycle-${outcome.old_agent_id}`, occurredAt: new Date(now()).toISOString(),
        detail: { reason_code: outcome.reason_code, missing_capabilities: outcome.missing_capabilities },
        ...(deps.publishActivity ? { publish: deps.publishActivity } : {}),
      }).catch(() => undefined);
    }
    // An abort is a normal answer, not an error: the caller asked whether this was
    // still possible, and "no, these are missing" is the answer.
    return context.json(outcome, 200);
  });

  return app;

  function audit(entry: Record<string, unknown>): void {
    const line = JSON.stringify({
      severity: entry.result === 'denied' ? 'WARNING' : 'INFO',
      logType: 'xaa.audit', actor_type: 'human', on_behalf_of: null,
      occurred_at: new Date(now()).toISOString(), ...entry,
    });
    (deps.auditWrite ?? ((value: string) => process.stdout.write(`${value}\n`)))(line);
  }
}

export default createApp;
