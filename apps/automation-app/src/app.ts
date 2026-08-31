import { Hono } from 'hono';
import type { DocumentStore } from '@xaa/gcp';
import { compile } from '@xaa/contracts';
import type { AutomationAppConfig } from './config.js';
import { createSessionStore, type SessionStore } from './auth/session-store.js';
import { requireUser, type UserVariables } from './auth/require-user.js';
import { createControlPlaneClient } from './http/control-plane-client.js';
import { requireAgentOwner, type AgentOwnerVariables } from './agents/require-owner.js';
import { readAgentStatus } from './agents/status.js';
import { stopAgent } from './agents/stop.js';
import { addInstruction, AgentNotActive } from './agents/instructions.js';
import { logAgentOperation } from './audit/logger.js';
import { createWorkDefinitionStore } from './work-definition/store.js';
import { confirm } from './work-definition/model.js';
import { LifetimeOutOfRange, validateLifetimeHours } from './work-definition/lifetime.js';
import { submitBusinessWorkRequest, WorkDefinitionNotConfirmed } from './work-definition/submit.js';
import {
  assertStillApproved, AlreadyApproved, ApprovalRequired, CapabilitiesChanged, createAgentDefinitionStore,
} from './agent-definition/approval.js';
import { decodePushMessage, storeActivityEvent } from './activity/subscriber.js';
import { verifyPushCaller } from './activity/oidc-verify.js';
import { readTimeline } from './activity/query.js';
import { createDemoReplayRoute } from './demo/replay-routes.js';
import { suggestAutomations } from './automation/suggestions.js';
import { buildDailyReport } from './reports/daily-report.js';
import { emitAgentStopped, emitConfirmed, emitProposed } from './activity/emit.js';
import { instructionRequestSchema, timelineResponseSchema } from './schemas/index.js';

export interface AutomationAppDeps {
  config: AutomationAppConfig;
  documents: DocumentStore;
  sessions?: SessionStore;
  verifyAccessToken(token: string): Promise<Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  auditWrite?: (line: string) => void;
  promptTemplate?: string;
  generate?: Parameters<typeof suggestAutomations>[0]['generate'];
  pushAudience?: string;
}

type Env = UserVariables & AgentOwnerVariables;

const assertInstruction: (value: unknown) => asserts value is { text: string } =
  compile<{ text: string }>(instructionRequestSchema);
const assertTimeline: (value: unknown) => asserts value is unknown = compile(timelineResponseSchema);

/**
 * The screen a person uses, and the only place they touch the platform.
 *
 * Two things shape this route table. Everything under `/api` runs behind
 * `requireUser`, so no handler ever decides for itself who is asking; and everything
 * under `/api/agents/:agent_id` additionally runs behind `requireAgentOwner`, so no
 * handler ever decides for itself whose agent it is. The push endpoint is the one
 * exception, authenticated by Pub/Sub's own OIDC token rather than a session.
 */
function createApp(deps: AutomationAppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const sessions = deps.sessions ?? createSessionStore(deps.documents);
  const workDefinitions = createWorkDefinitionStore(deps.documents);
  const agentDefinitions = createAgentDefinitionStore(deps.documents);
  const now = deps.now ?? (() => Date.now());

  app.get('/healthz', (context) => context.json({ status: 'ok', app: 'automation-app' }));

  /**
   * Pub/Sub, not a person. Verified by the delivery's OIDC token: the body names the
   * subject whose timeline the row lands in, so knowing the sender is the only defence.
   */
  app.post('/internal/activity/push', async (context) => {
    try {
      await verifyPushCaller({
        authorization: context.req.header('authorization'),
        audience: deps.pushAudience ?? new URL(context.req.url).origin,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch {
      return context.json({ error: 'unauthorized' }, 401);
    }
    let event;
    try {
      event = decodePushMessage(await context.req.json());
    } catch {
      // 400, so Pub/Sub stops redelivering something that will never validate.
      return context.json({ error: 'invalid_event' }, 400);
    }
    const outcome = await storeActivityEvent({ documents: deps.documents, event });
    return context.json({ status: outcome }, 200);
  });

  app.use('/api/*', requireUser({ sessions, clientId: deps.config.clientId, verifyAccessToken: deps.verifyAccessToken }));

  app.post('/api/automation/suggestions', async (context) => {
    const body = await context.req.json().catch(() => ({})) as { from?: string; to?: string };
    const suggestions = await suggestAutomations({
      signals: [],
      promptTemplate: deps.promptTemplate ?? '{{signals}}',
      ...(deps.generate ? { generate: deps.generate } : {}),
    });
    void body;
    return context.json(suggestions, 200);
  });

  /**
   * A report is written when someone asks for one. The route is under `/api`, behind a
   * session — there is no `/internal` variant and no scheduler job, so nothing can
   * produce a report without a person having requested it.
   */
  app.post('/api/reports/daily', async (context) => {
    const body = await context.req.json().catch(() => ({})) as { from?: string; to?: string };
    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const report = await buildDailyReport({
      signals: [], ...(deps.generate ? { generate: deps.generate } : {}),
    });
    if (!report) return context.json({ error: 'no_work_log' }, 422);
    const response = await (deps.fetchImpl ?? globalThis.fetch)(
      new URL('/documents', deps.config.docsApiUrl).toString(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'daily_report', title: report.title, body: report.body }),
      },
    );
    const created = await response.json().catch(() => ({})) as { document_id?: string };
    return context.json({ document_id: created.document_id ?? null }, 201);
  });

  app.post('/api/work-definitions', async (context) => {
    const body = await context.req.json().catch(() => ({})) as Record<string, unknown>;
    let hours: number;
    try {
      hours = validateLifetimeHours(body.requested_lifetime_hours ?? deps.config.defaultAgentLifetimeHours);
    } catch (error) {
      if (error instanceof LifetimeOutOfRange) return context.json({ error: error.code }, 400);
      throw error;
    }
    const definition = await workDefinitions.create({
      human_subject: context.get('humanSubject'),
      purpose: String(body.purpose ?? ''),
      description: String(body.description ?? ''),
      operations: Array.isArray(body.operations) ? body.operations.map(String) : [],
      user_confirmations: Array.isArray(body.user_confirmations) ? body.user_confirmations.map(String) : [],
      safety_notes: Array.isArray(body.safety_notes) ? body.safety_notes.map(String) : [],
      requested_lifetime_hours: hours,
    }, now());
    await emitProposed({ humanSubject: definition.human_subject, occurredAt: new Date(now()).toISOString() },
      { purpose: definition.purpose, workDefinitionId: definition.work_definition_id });
    return context.json(definition, 201);
  });

  /** The only writer of `status`. A message endpoint deliberately has no such branch. */
  app.post('/api/work-definitions/:id/confirm', async (context) => {
    const definition = await workDefinitions.find(context.req.param('id'));
    if (!definition || definition.human_subject !== context.get('humanSubject')) {
      return context.json({ error: 'not_found' }, 404);
    }
    const confirmed = confirm(definition, new Date(now()).toISOString());
    await workDefinitions.save(confirmed);
    await emitConfirmed({ humanSubject: confirmed.human_subject, occurredAt: new Date(now()).toISOString() },
      { purpose: confirmed.purpose, workDefinitionId: confirmed.work_definition_id });
    return context.json(confirmed, 200);
  });

  app.post('/api/work-definitions/:id/messages', async (context) => {
    const definition = await workDefinitions.find(context.req.param('id'));
    if (!definition || definition.human_subject !== context.get('humanSubject')) {
      return context.json({ error: 'not_found' }, 404);
    }
    // Whatever the model says, the state is untouched here.
    return context.json({ work_definition_id: definition.work_definition_id, status: definition.status }, 200);
  });

  app.post('/api/work-definitions/:id/submit', async (context) => {
    const definition = await workDefinitions.find(context.req.param('id'));
    if (!definition || definition.human_subject !== context.get('humanSubject')) {
      return context.json({ error: 'not_found' }, 404);
    }
    try {
      const response = await submitBusinessWorkRequest({
        definition,
        client: createControlPlaneClient({
          session: context.get('session'), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        }),
        authorizationPlatformUrl: deps.config.authorizationPlatformUrl,
      });
      return context.json(await response.json().catch(() => ({})), response.status as 200);
    } catch (error) {
      if (error instanceof WorkDefinitionNotConfirmed) return context.json({ error: error.code }, 409);
      return context.json({ error: 'internal_error' }, 500);
    }
  });

  app.post('/api/agent-definitions/:id/approve', async (context) => {
    try {
      const approved = await agentDefinitions.approve(context.req.param('id'), context.get('humanSubject'), now());
      return context.json(approved, 200);
    } catch (error) {
      if (error instanceof AlreadyApproved) return context.json({ error: error.code }, 409);
      if (error instanceof ApprovalRequired) return context.json({ error: 'not_found' }, 404);
      throw error;
    }
  });

  app.post('/api/agent-definitions/:id/provision', async (context) => {
    const definition = await agentDefinitions.find(context.req.param('id'));
    if (!definition || definition.human_subject !== context.get('humanSubject')) {
      return context.json({ error: 'not_found' }, 404);
    }
    const decision = await deps.documents.get<{ effective_capabilities?: string[] }>(
      'authorization_decisions', definition.decision_id,
    );
    try {
      await assertStillApproved(definition, decision?.effective_capabilities ?? definition.presented_capabilities);
    } catch (error) {
      if (error instanceof ApprovalRequired || error instanceof CapabilitiesChanged) {
        return context.json({ error: error.code }, 409);
      }
      throw error;
    }
    const response = await createControlPlaneClient({
      session: context.get('session'), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }).send('agent-provisioner', {
      url: new URL('/api/provisioning', deps.config.agentProvisionerUrl).toString(),
      method: 'POST',
      body: { decision_id: definition.decision_id, agent_definition_id: definition.agent_definition_id },
      requiredScope: 'agent:provision',
    });
    return context.json(await response.json().catch(() => ({})), response.status as 200);
  });

  app.use('/api/agents/:agent_id/*', requireAgentOwner({
    documents: deps.documents, ...(deps.auditWrite ? { write: deps.auditWrite } : {}), now,
  }));

  app.get('/api/agents/:agent_id/status', async (context) => {
    const status = await readAgentStatus({ documents: deps.documents, agentId: context.get('agentId'), now: now() });
    audit('status_read', context.get('agentId'), context.get('humanSubject'));
    return context.json(status, 200);
  });

  app.post('/api/agents/:agent_id/stop', async (context) => {
    const agentId = context.get('agentId');
    const response = await stopAgent({
      client: createControlPlaneClient({
        session: context.get('session'), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
      lifecycleManagerUrl: deps.config.lifecycleManagerUrl,
      agentId,
    });
    audit('stop', agentId, context.get('humanSubject'));
    if (response.ok) {
      await emitAgentStopped({ humanSubject: context.get('humanSubject'), occurredAt: new Date(now()).toISOString() }, { agentId });
      return context.json({ status: 'stopping' }, 200);
    }
    // Whatever Lifecycle said, unchanged: telling the person it stopped when it did not
    // would be the worst possible lie for this particular button.
    return context.json(await response.json().catch(() => ({})), response.status as 200);
  });

  app.post('/api/agents/:agent_id/instructions', async (context) => {
    const body = await context.req.json().catch(() => undefined);
    try {
      assertInstruction(body);
    } catch {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const agentId = context.get('agentId');
    try {
      const instruction = await addInstruction({
        documents: deps.documents, agentId, text: body.text, createdBy: context.get('humanSubject'), now: now(),
      });
      audit('add_instruction', agentId, context.get('humanSubject'), body.text);
      return context.json(instruction, 201);
    } catch (error) {
      if (error instanceof AgentNotActive) {
        audit('add_instruction', agentId, context.get('humanSubject'), body.text);
        return context.json({ error: error.code }, 409);
      }
      throw error;
    }
  });

  app.get('/api/activity/tasks', async (context) => {
    // A `?human_subject=` in the query is read by nothing here. It is not an error
    // either: refusing it would confirm that the parameter means something.
    const tasks = await readTimeline({ documents: deps.documents, humanSubject: context.get('humanSubject') });
    const body = { tasks };
    assertTimeline(body);
    return context.json(body, 200);
  });

  app.get('/api/activity/tasks/:task_id', async (context) => {
    const tasks = await readTimeline({
      documents: deps.documents, humanSubject: context.get('humanSubject'), taskId: context.req.param('task_id'),
    });
    if (tasks.length === 0) return context.json({ error: 'not_found' }, 404);
    const body = { tasks };
    assertTimeline(body);
    return context.json(body, 200);
  });

  app.route('/api/demo', createDemoReplayRoute({ documents: deps.documents }));

  return app;

  function audit(operation: 'status_read' | 'stop' | 'add_instruction', agentId: string, subject: string, text?: string): void {
    logAgentOperation({
      operation, agent_id: agentId, actor_type: 'human', actor_id: subject, on_behalf_of: subject,
      occurred_at: new Date(now()).toISOString(), result: 'success',
      ...(text === undefined ? {} : { instruction_text: text }),
    }, deps.auditWrite);
  }
}

export default createApp;
