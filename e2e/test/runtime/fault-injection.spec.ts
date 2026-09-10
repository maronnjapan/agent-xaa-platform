import { describe, expect, it, beforeEach } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import {
  drainActivityQueueForTesting, resetActivityPublisherForTesting, type ActivityEvent,
} from '@xaa/contracts';
import { runReasoningLoop } from '@xaa/agent-runtime/src/reasoning/loop';
import { createTerminalEmitter } from '@xaa/agent-runtime/src/telemetry/task-outcome';
import { publishTaskOutcome } from '@xaa/agent-runtime/src/telemetry/activity';
import { storeActivityEvent } from '@xaa/automation-app/src/activity/subscriber';
import { startAutomationAppHarness } from '../../harness/automation-app.js';
import { seedDocument } from '../../harness/resource.js';
import { docsRuntime } from './runtime-flow-docs.spec.js';

/**
 * The failure exercise, end to end.
 *
 * A person asks the platform to make their own running agent fail, and then has to be
 * able to see that it did. Every hop is the production one: the request goes in over
 * the app's HTTP API, is stored as an ordinary instruction, is read by the real
 * reasoning loop out of the same Firestore, and comes back out as the status the agent
 * page renders and the row the timeline lists.
 *
 * The exercise is only useful if it stops a *working* agent, so the loop makes one real
 * tool call against the real Document API first, and the fault arrives while the model
 * is deciding the next step — the moment a person would actually press the button.
 */
describe('the failure exercise on a running agent', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  it('is requested through the app, crashes the real loop, and surfaces as a failure', async () => {
    const humanSubject = 'testuser';
    const shared = createFirestoreDouble();
    const { runtime, agentOp, docs, subjectToken } = await docsRuntime({ shared });
    const automation = await startAutomationAppHarness({ shared, humanSubject, faultInjection: true });
    runtime.context.tokens.set('subject', subjectToken, Date.now() + 3_600_000);
    await seedDocument(docs, humanSubject);

    const faults = `/api/agents/${agentOp.agentId}/faults`;
    const request = (body: unknown = { kind: 'runtime_crash' }): Promise<Response> => automation.fetch(faults, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    // Nothing has run yet, so there is no execution to fail: the app refuses rather
    // than storing a request the Runtime would never read.
    expect((await request()).status).toBe(409);

    // The model works, and the person presses the button while it is deciding. Only
    // `kind` is accepted — the task the fault binds to is the one the checkpoint names,
    // never one the caller chooses.
    const steps = [
      async () => {
        expect((await request()).status).toBe(202);
        // A second request while the first is unapplied is refused, so one press cannot
        // queue a crash for a later execution.
        expect((await request()).status).toBe(409);
        expect((await request({ kind: 'runtime_crash', task_id: 'another-task' })).status).toBe(400);
        expect((await request({ kind: 'arbitrary_command' })).status).toBe(400);
        return { done: false, tool_call: { tool_id: 'internal.document.list', parameters: {} } };
      },
      async () => ({ done: true }),
    ];
    let step = 0;
    const vertex = { generateJson: async <T>() => (await steps[step++]?.() ?? { done: true }) as T };

    const silent = createLogger('agent-runtime', 'agent_runtime', () => {});
    const terminal = createTerminalEmitter(async (eventType) => publishTaskOutcome({
      context: {
        humanSubject, agentId: agentOp.agentId, taskId: runtime.context.taskId,
        traceId: runtime.logContext.trace_id, manifest: runtime.context.manifest,
      },
      eventType, logger: silent, ctx: runtime.logContext, occurredAt: '2026-01-01T00:00:02.000Z',
    }));

    await expect(runReasoningLoop({
      context: runtime.context, http: runtime.http, logger: silent,
      logContext: runtime.logContext, vertex,
    })).rejects.toThrow('injected_runtime_crash');

    // main.ts publishes from both `catch` and `finally`; the emitter is what keeps that
    // from becoming two rows for one task.
    await terminal.emitTerminalOnce('TASK_FAILED');
    await terminal.emitTerminalOnce('TASK_FAILED');

    // The tool call before the fault really reached the Document API, so what the
    // exercise interrupted was an agent that was working.
    expect(runtime.hostCalls).toContain(new URL(docs.resourceUri).origin);

    // The execution failed; the *agent* did not change Lifecycle state, because the
    // Runtime does not own one (docs 07 §2). The page says both, separately.
    const status = await (await automation.fetch(`/api/agents/${agentOp.agentId}/status`)).json();
    expect(status).toMatchObject({
      agent_status: 'ACTIVE',
      current_task: null,
      execution_failure: 'injected_runtime_crash',
      tool_invocations: [{ tool_id: 'internal.document.list', outcome: 'success' }],
    });
    const page = await (await automation.fetch(`/agents/${agentOp.agentId}`)).text();
    expect(page).toContain('data-failure="injected_runtime_crash"');
    expect(page).toContain('data-action="inject-fault"');

    // And the execution is over, so the exercise cannot be requested again against it.
    expect((await request()).status).toBe(409);

    const published = drainActivityQueueForTesting();
    expect(published.map((event) => (event.detail as { event_type: string }).event_type)).toEqual(['TASK_FAILED']);
    expect(published[0]).toMatchObject({ outcome: 'failed', agent_id: agentOp.agentId });
    for (const event of published) await storeActivityEvent({ documents: automation.documents, event });

    const listed = await (await automation.fetch('/api/activity/tasks')).json() as {
      tasks: Array<{ task_id: string; status: string; terminal_outcome?: string; events?: ActivityEvent[] }>;
    };
    const task = listed.tasks.find((entry) => entry.task_id === runtime.context.taskId)!;
    expect(task).toMatchObject({ status: 'completed', terminal_outcome: 'failed' });

    // The audit trail names the person who asked.
    const audited = automation.auditLines.map((line) => JSON.parse(line) as { operation: string; actor_id: string });
    expect(audited.filter((entry) => entry.operation === 'fault_injection')[0])
      .toMatchObject({ actor_id: humanSubject });
  });

  it('is absent, and refused, on a deployment that did not opt in', async () => {
    const shared = createFirestoreDouble();
    const { agentOp } = await docsRuntime({ shared });
    const automation = await startAutomationAppHarness({ shared });

    const response = await automation.fetch(`/api/agents/${agentOp.agentId}/faults`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'runtime_crash' }),
    });
    expect(response.status).toBe(404);
    expect(await (await automation.fetch(`/agents/${agentOp.agentId}`)).text())
      .not.toContain('data-action="inject-fault"');
  });
});
