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
import { createLoginRoutes } from './auth/login-flow.js';
import { createPageRoutes } from './ui/routes.js';
import { createSignalSource } from './signals/registry.js';
import type { WorkSignalSource } from './signals/work-signal-source.js';
import { loadSuggestionPrompt } from './prompts/load.js';
import { reviseDraft } from './work-definition/dialogue.js';

export interface AutomationAppDeps {
  config: AutomationAppConfig;
  documents: DocumentStore;
  sessions?: SessionStore;
  verifyAccessToken(token: string): Promise<Record<string, unknown>>;
  verifyIdToken(token: string): Promise<Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  auditWrite?: (line: string) => void;
  promptTemplate?: string;
  signals?: WorkSignalSource;
  generate?: Parameters<typeof suggestAutomations>[0]['generate'];
  pushAudience?: string;
  identityTokenProvider?: (audience: string) => Promise<string>;
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
  const promptTemplate = deps.promptTemplate ?? loadSuggestionPrompt();
  // The documents are read as this app, with its own service identity: the person in
  // front of the screen has no agent yet, so there is no delegation to travel on
  // (T-APP-04), and the read happens before anything has been decided about one.
  const docsOrigin = new URL(deps.config.docsApiUrl).origin;
  const docsAuthorization = async (): Promise<string> =>
    (deps.identityTokenProvider ? `Bearer ${await deps.identityTokenProvider(docsOrigin)}` : '');
  const signals = deps.signals ?? createSignalSource('document-rs', {
    baseUrl: deps.config.docsApiUrl,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    authorization: docsAuthorization,
  });

  app.get('/healthz', (context) => context.json({ status: 'ok', app: 'automation-app' }));
  app.route('/', createLoginRoutes({
    config: deps.config,
    documents: deps.documents,
    sessions,
    verifyIdToken: deps.verifyIdToken,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    now,
  }));

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

  /**
   * Where the browser lands after a consent screen.
   *
   * The Agent OP's `/xaa/callback` sends the person here with the transaction id and a
   * one-time code, because the Provisioner is internal-only and no browser can reach it
   * (RULE-37). This route is the only thing that can turn that return trip into a
   * resumed provisioning: it presents the code on the person's own session, and then
   * either follows the next consent URL the Provisioner names or comes back to the
   * dashboard.
   */
  app.get(
    '/provisioning/resume',
    requireUser({ sessions, clientId: deps.config.clientId, verifyAccessToken: deps.verifyAccessToken }),
    async (context) => {
      const transactionId = context.req.query('transaction_id');
      const code = context.req.query('code');
      if (!transactionId || !code) return consentFailurePage(400);

      let response: Response;
      try {
        response = await createControlPlaneClient({
          session: context.get('session'),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.identityTokenProvider ? { identityTokenProvider: deps.identityTokenProvider } : {}),
        }).send('agent-provisioner', {
          url: new URL(
            `/provisioning/${encodeURIComponent(transactionId)}/resume`,
            deps.config.agentProvisionerUrl,
          ).toString(),
          method: 'POST',
          body: { one_time_code: code },
          requiredScope: 'agent:provision',
        });
      } catch {
        return consentFailurePage(502);
      }
      if (!response.ok) return consentFailurePage(502);

      // A second consent is answered the same way the first was: by following the URL
      // the Provisioner names. This app never builds one (RULE-37).
      const body = await response.json().catch(() => ({})) as { consent_url?: unknown };
      if (typeof body.consent_url === 'string') return context.redirect(body.consent_url, 302);
      return context.redirect('/', 302);
    },
  );

  app.use('/api/*', requireUser({ sessions, clientId: deps.config.clientId, verifyAccessToken: deps.verifyAccessToken }));

  app.post('/api/automation/suggestions', async (context) => {
    const body = await context.req.json().catch(() => ({})) as { from?: unknown; to?: unknown };
    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const suggestions = await suggestAutomations({
      signals: await signals.fetch({ humanSubject: context.get('humanSubject'), from: body.from, to: body.to }),
      promptTemplate,
      ...(deps.generate ? { generate: deps.generate } : {}),
    });
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
      signals: await signals.fetch({ humanSubject: context.get('humanSubject'), from: body.from, to: body.to }),
      ...(deps.generate ? { generate: deps.generate } : {}),
    });
    if (!report) return context.json({ error: 'no_work_log' }, 422);
    const authorization = await docsAuthorization();
    const response = await (deps.fetchImpl ?? globalThis.fetch)(
      new URL('/documents', deps.config.docsApiUrl).toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        // `occurred_at` is what the report is about, so the Resource Server stores it
        // under the day it covers rather than the moment it was written.
        body: JSON.stringify({
          type: 'daily_report', title: report.title, body: report.body, occurred_at: body.to,
        }),
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
    const body = await context.req.json().catch(() => ({})) as { text?: unknown };
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const draft = await reviseDraft({
      definition, message: body.text, ...(deps.generate ? { generate: deps.generate } : {}),
    });
    // Whatever the model says, the state is untouched here: the revision covers five
    // fields and `status` is not one of them.
    const revised = draft
      ? { ...definition, ...draft, updated_at: new Date(now()).toISOString() }
      : definition;
    if (draft) await workDefinitions.save(revised);
    return context.json(revised, 200);
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
          session: context.get('session'),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.identityTokenProvider ? { identityTokenProvider: deps.identityTokenProvider } : {}),
        }),
        authorizationPlatformUrl: deps.config.authorizationPlatformUrl,
      });
      const decision = await response.json().catch(() => ({})) as {
        decision_id?: unknown;
        effective_capabilities?: unknown;
        security_profile?: { isolation_level?: unknown };
      };
      if (!response.ok || typeof decision.decision_id !== 'string') {
        return context.json(decision, response.status as 200);
      }
      // What the person is about to be shown, recorded before they see it. Approval and
      // provisioning both read this record, so without it the decision came back and the
      // rest of the flow had nothing to act on (RULE-08).
      const agentDefinition = await agentDefinitions.create({
        humanSubject: definition.human_subject,
        workDefinitionId: definition.work_definition_id,
        decisionId: decision.decision_id,
        capabilities: Array.isArray(decision.effective_capabilities)
          ? decision.effective_capabilities.map(String)
          : [],
        isolationLevel: typeof decision.security_profile?.isolation_level === 'string'
          ? decision.security_profile.isolation_level
          : 'standard',
      }, now());
      return context.json({ ...decision, agent_definition_id: agentDefinition.agent_definition_id }, 200);
    } catch (error) {
      if (error instanceof WorkDefinitionNotConfirmed) return context.json({ error: error.code }, 409);
      return context.json({ error: 'internal_error' }, 500);
    }
  });

  app.post('/api/agent-definitions/:id/approve', async (context) => {
    try {
      // Ownership is settled before the record is touched, and a stranger's id answers
      // 404 like a missing one: anything else would confirm the record exists (RULE-56).
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
    // The Provisioner's body is fixed at three keys and rejects anything else
    // (`additionalProperties: false`), so the lifetime comes from the work definition
    // this agent was approved for rather than from a fourth key it would refuse.
    const work = await workDefinitions.find(definition.work_definition_id);
    if (!work) return context.json({ error: 'not_found' }, 404);
    const response = await createControlPlaneClient({
      session: context.get('session'),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.identityTokenProvider ? { identityTokenProvider: deps.identityTokenProvider } : {}),
    }).send('agent-provisioner', {
      url: new URL('/provisioning', deps.config.agentProvisionerUrl).toString(),
      method: 'POST',
      body: {
        decision_id: definition.decision_id,
        task_id: definition.work_definition_id,
        requested_lifetime_hours: work.requested_lifetime_hours,
      },
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
        session: context.get('session'),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.identityTokenProvider ? { identityTokenProvider: deps.identityTokenProvider } : {}),
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

  app.route('/', createPageRoutes({
    config: deps.config,
    documents: deps.documents,
    sessions,
    verifyAccessToken: deps.verifyAccessToken,
    ...(deps.auditWrite ? { auditWrite: deps.auditWrite } : {}),
    now,
  }));

  return app;

  function audit(operation: 'status_read' | 'stop' | 'add_instruction', agentId: string, subject: string, text?: string): void {
    logAgentOperation({
      operation, agent_id: agentId, actor_type: 'human', actor_id: subject, on_behalf_of: subject,
      occurred_at: new Date(now()).toISOString(), result: 'success',
      ...(text === undefined ? {} : { instruction_text: text }),
    }, deps.auditWrite);
  }
}

/** No detail: the browser is told the attempt failed, and the reason stays in the logs. */
const CONSENT_FAILURE_PAGE = '<!doctype html><meta charset="utf-8"><title>Agent XAA</title>'
  + '<p>同意の結果を受け取れませんでした。管理画面からやり直してください。</p>';

function consentFailurePage(status: 400 | 502): Response {
  return new Response(CONSENT_FAILURE_PAGE, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export default createApp;
