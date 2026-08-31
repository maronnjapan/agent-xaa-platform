import { describe, expect, it, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  drainActivityQueueForTesting, resetActivityPublisherForTesting, validateActivityEvent, type ActivityEvent,
} from '@xaa/contracts';
import { createFirestoreDouble } from '@xaa/gcp';
import { runReasoningLoop } from '@xaa/agent-runtime/src/reasoning/loop';
import { createRuntimeStore } from '@xaa/agent-runtime/src/store/runtime-store';
import { createExecutionContext } from '@xaa/agent-runtime/src/context/execution-context';
import { manifestSha256 } from '@xaa/agent-runtime/src/manifest/load';
import { buildAllowedHosts } from '@xaa/agent-runtime/src/http/allowed-hosts';
import { createRuntimeHttpClient } from '@xaa/agent-runtime/src/http/http-client';
import { publishToolBlocked, publishTaskOutcome } from '@xaa/agent-runtime/src/telemetry/activity';
import { decideTaskOutcome } from '@xaa/agent-runtime/src/telemetry/task-outcome';
import { storeActivityEvent } from '@xaa/automation-app/src/activity/subscriber';
import { readTimeline } from '@xaa/automation-app/src/activity/query';
import { TimelinePage } from '@xaa/automation-app/src/ui/pages/timeline';
import { buildReplayPlan } from '@xaa/automation-app/client/src/replay-plan';
import { SOURCE_TO_NODE } from '@xaa/automation-app/src/ui/replay/nodes';
import { createLogger } from '@xaa/logging';
import { AGENT_OP_BASE, startAgentOp } from '../../harness/agent-op.js';
import { HUMAN_IDP_ISSUER, idpPublicJwk } from '../../harness/human-idp.js';
import { startResource } from '../../harness/resource.js';
import { nativeManifest } from '../../harness/agent-runtime.js';
import { startAutomationAppHarness } from '../../harness/automation-app.js';
import { humanIdToken } from '../runtime/native-xaa-path.spec.js';

const render = async (element: unknown): Promise<string> => String(await element);
const silent = createLogger('agent-runtime', 'agent_runtime', () => {});

/**
 * Demo D-1, run as real operations rather than a script.
 *
 * A person provisions an agent that can only read documents, then sends it a follow-up
 * instruction asking it to approve a payment. The instruction goes in through the
 * ordinary API — nothing writes to Firestore behind the app's back — the Runtime reads
 * it, the model is taken in by it, and the Tool Executor refuses. What the person then
 * sees is one TOOL_BLOCKED, one TASK_BLOCKED, and a replay whose arrow stops before the
 * Finance API.
 */
describe('demo D-1: an out-of-permission instruction', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  it('is refused, recorded once, and shown stopping short of its destination', async () => {
    const humanSubject = 'testuser';
    const shared = createFirestoreDouble();
    const automation = await startAutomationAppHarness({ shared, humanSubject });

    const subjectToken = await humanIdToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanSubject });
    const docs = await startResource({ kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });

    // The agent exists and is ACTIVE, with a manifest that can only read documents.
    await automation.provisionerStore.set('agents', `${agentOp.agentId}__meta`, {
      agent_id: agentOp.agentId, human_subject: humanSubject, status: 'ACTIVE',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await automation.runtimeStore.set('agents', `${agentOp.agentId}__state`, { agent_status: 'ACTIVE' });

    // The person sends the instruction through the ordinary endpoint.
    const posted = await automation.fetch(`/api/agents/${agentOp.agentId}/instructions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '未払いの請求書を承認しておいてください' }),
    });
    expect(posted.status).toBe(201);

    // The Runtime, sharing the same store, picks the instruction up on its next step.
    const manifest = nativeManifest({ agentId: agentOp.agentId, resource: docs, kind: 'docs' });
    const raw = JSON.stringify(manifest);
    const runtimeStore = createRuntimeStore({
      documents: (await import('@xaa/gcp')).createFirestoreDocumentStore(shared, 'agent-runtime'),
      agentId: agentOp.agentId,
    });
    const context = await createExecutionContext({
      env: {
        AGENT_ID: agentOp.agentId, HUMAN_SUBJECT: humanSubject, TASK_ID: 'task-1',
        AGENT_CREATED_AT: new Date(Date.now() - 60_000).toISOString(),
        AGENT_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
        AGENT_OP_BASE_URL: AGENT_OP_BASE, TOOL_MANIFEST: raw, TOOL_MANIFEST_SHA256: manifestSha256(raw),
        AGENT_CLIENT_PRIVATE_JWK: JSON.stringify(await webcrypto.subtle.exportKey('jwk', agentOp.agentKeyPair.privateKey)),
        ISOLATION_LEVEL: 'standard', executionId: 'demo-execution', taskIndex: 0,
      },
      store: runtimeStore,
      processEnv: {},
    });
    context.tokens.set('subject', subjectToken, Date.now() + 3_600_000);

    let agentOpCalls = 0;
    const http = createRuntimeHttpClient({
      allowedHosts: buildAllowedHosts({ AGENT_OP_BASE_URL: AGENT_OP_BASE }, context.manifest),
      fetch: async (url, init) => {
        const target = new URL(url);
        if (target.origin === new URL(AGENT_OP_BASE).origin) {
          agentOpCalls += 1;
          return agentOp.fetch(`${target.pathname}${target.search}`, init);
        }
        if (target.origin === new URL(docs.asIssuer).origin) return docs.as(`${target.pathname}${target.search}`, init);
        return docs.api(`${target.pathname}${target.search}`, init);
      },
    });

    // The model does what the instruction asks. It gets as far as naming the tool.
    const steps = [
      { done: false, tool_call: { tool_id: 'internal.finance.payment.approve', parameters: { id: 'pay_1', amount: 100 } } },
      { done: true },
    ];
    let index = 0;
    const loop = await runReasoningLoop({
      context, http, logger: silent,
      logContext: { request_id: 'demo', trace_id: 'demo', agent_id: agentOp.agentId, human_subject: humanSubject },
      vertex: { generateJson: async <T>() => (steps[index++] ?? { done: true }) as T },
      stageWrite: () => {},
    });

    expect(loop.results[0]).toMatchObject({
      outcome: 'blocked', reason: 'not_in_allowed_tools', error_code: 'tool_not_allowed',
    });
    // The instruction was read, and nothing reached the Agent OP for it.
    expect(agentOpCalls).toBe(0);
    const state = await automation.runtimeStore.get<{ execution_state: { rejected_instruction: unknown[] } }>(
      'agents', `${agentOp.agentId}__state`,
    );
    expect(state!.execution_state.rejected_instruction).toHaveLength(1);

    // The Runtime publishes exactly one TOOL_BLOCKED and one TASK_BLOCKED.
    const activityContext = {
      humanSubject, agentId: agentOp.agentId, taskId: 'task-1', traceId: 'demo', manifest: context.manifest,
    };
    const ctx = { request_id: 'demo', trace_id: 'demo', agent_id: agentOp.agentId, human_subject: humanSubject };
    await publishToolBlocked({
      context: activityContext, toolId: 'internal.finance.payment.approve',
      reason: 'not_in_allowed_tools', logger: silent, ctx, occurredAt: '2026-01-01T00:00:01.000Z',
    });
    await publishTaskOutcome({
      context: activityContext, eventType: decideTaskOutcome(loop.results), logger: silent, ctx,
      occurredAt: '2026-01-01T00:00:02.000Z',
    });

    const published = drainActivityQueueForTesting();
    const types = published.map((entry) => (entry.detail as { event_type: string }).event_type);
    expect(types.filter((type) => type === 'TOOL_BLOCKED')).toHaveLength(1);
    expect(types.filter((type) => type === 'TASK_BLOCKED')).toHaveLength(1);

    // The events reach the person's timeline the ordinary way.
    for (const entry of published) {
      await storeActivityEvent({
        documents: automation.documents,
        event: withTarget(entry),
      });
    }
    const listed = await (await automation.fetch('/api/activity/tasks')).json() as {
      tasks: Array<{ task_id: string; status: string; terminal_outcome?: string; events?: ActivityEvent[] }>;
    };
    const task = listed.tasks.find((entry) => entry.task_id === 'task-1')!;
    expect(task.status).toBe('completed');
    expect(task.terminal_outcome).toBe('blocked');

    // And the replay stops before the Finance API rather than reaching it.
    const tasks = await readTimeline({ documents: automation.documents, humanSubject });
    const html = await render(TimelinePage({ tasks }));
    expect(html).toContain('data-node="resource-api"');
    expect(html.match(/data-reached="false"/g)!.length).toBeGreaterThan(0);

    const plan = buildReplayPlan(task.events!.map((entry) => ({
      event_id: entry.event_id, occurred_at: entry.occurred_at, source: entry.source,
      outcome: entry.outcome, message: entry.message, ...(entry.detail ? { detail: entry.detail as Record<string, unknown> } : {}),
    })), (source) => SOURCE_TO_NODE[source] ?? null);
    const blockedSteps = plan.filter((step) => step.blocked);
    expect(blockedSteps).toHaveLength(1);
    expect(blockedSteps[0]!.stopRatio).toBe(0.6);
    expect(blockedSteps[0]!.to).toBe('resource-api');
  });
});

/**
 * The Runtime does not know it is drawing a picture, so the replay needs to be told
 * which box the blocked call was heading for. The tool's destination is the Resource
 * API; adding it here keeps the canvas honest without teaching the Runtime about nodes.
 */
function withTarget(event: ActivityEvent): ActivityEvent {
  const detail = event.detail as { event_type?: string } | undefined;
  if (detail?.event_type !== 'TOOL_BLOCKED') return event;
  return validateActivityEvent({ ...event, detail: { ...detail, target: 'resource-api' } }) as ActivityEvent;
}
