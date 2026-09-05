import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { AGENT_STATUS_RESPONSE_KEYS } from '../src/agents/status.js';
import { AUDIT_OPERATIONS } from '../src/audit/logger.js';
import { instructionRequestSchema } from '../src/schemas/index.js';
import { AGENT_ID, SUBJECT, seedAgent, startAutomationApp } from './helpers.js';
import { STOP_ACCEPTED, start as startAgentDetail } from '../../automation-app/client/src/agent-detail.js';
import { FakeDocument, FakeElement, element } from './fake-dom.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const OTHER_AGENT = 'agent-zzzzzzzzzzzzzzzzzzzzzzzzzz';

describe('agent ownership', () => {
  it('returns 404 for other user on all three operations', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { agentId: OTHER_AGENT, humanSubject: 'someone-else' });

    const responses = await Promise.all([
      harness.fetch(`/api/agents/${OTHER_AGENT}/status`),
      harness.fetch(`/api/agents/${OTHER_AGENT}/stop`, { method: 'POST' }),
      harness.fetch(`/api/agents/${OTHER_AGENT}/instructions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('says nothing about forbidden or 403', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { agentId: OTHER_AGENT, humanSubject: 'someone-else' });
    const response = await harness.fetch(`/api/agents/${OTHER_AGENT}/status`);
    const body = await response.text();
    expect(response.status).not.toBe(403);
    expect(body).not.toContain('forbidden');
    expect(body).not.toContain('403');
  });

  it('answers the same 404 for an agent that does not exist', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/api/agents/agent-nonexistent00000000000000/status');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('records a denied line for each refused operation', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { agentId: OTHER_AGENT, humanSubject: 'someone-else' });
    await harness.fetch(`/api/agents/${OTHER_AGENT}/status`);
    await harness.fetch(`/api/agents/${OTHER_AGENT}/stop`, { method: 'POST' });
    await harness.fetch(`/api/agents/${OTHER_AGENT}/instructions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
    });
    const denied = harness.auditLines.map((line) => JSON.parse(line) as { result: string; operation: string })
      .filter((entry) => entry.result === 'denied');
    expect(denied).toHaveLength(3);
    expect(denied.map((entry) => entry.operation).sort()).toEqual(['add_instruction', 'status_read', 'stop']);
  });

  it('builds agent paths in one place only', () => {
    expect(() => execFileSync('bash', ['scripts/checks/no-direct-agent-state-read.sh'], { cwd: repoRoot })).not.toThrow();
  });
});

describe('the status endpoint', () => {
  it('returns exactly 4 keys', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, {
      state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' }, pending_tool_calls: [] },
    });
    const response = await harness.fetch(`/api/agents/${AGENT_ID}/status`);
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json() as object).sort()).toEqual([...AGENT_STATUS_RESPONSE_KEYS].sort());
  });

  it('projects tool invocations to three fields and drops the rest', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, {
      state: {
        agent_status: 'ACTIVE',
        task_context: { task_id: 'task-1' },
        pending_tool_calls: [{
          tool_id: 'internal.document.list', outcome: 'success', reason: 'ok',
          access_token: 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig', private_key: 'secret',
        }],
      },
    });
    const body = await (await harness.fetch(`/api/agents/${AGENT_ID}/status`)).json() as {
      tool_invocations: Array<Record<string, unknown>>;
    };
    expect(Object.keys(body.tool_invocations[0]!).sort()).toEqual(['outcome', 'summary', 'tool_id']);
    const serialized = JSON.stringify(body);
    for (const forbidden of ['token', 'secret', 'private_key']) expect(serialized).not.toContain(forbidden);
  });

  it('reports zero remaining seconds once the agent has expired', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const body = await (await harness.fetch(`/api/agents/${AGENT_ID}/status`)).json() as { remaining_seconds: number };
    expect(body.remaining_seconds).toBe(0);
  });
});

describe('stopping an agent', () => {
  it('delegates to lifecycle manager', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: () => new Response(JSON.stringify({ status: 'revoking' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    });
    await seedAgent(harness);
    const response = await harness.fetch(`/api/agents/${AGENT_ID}/stop`, { method: 'POST' });
    expect(response.status).toBe(200);
    const call = harness.upstream.at(-1)!;
    expect(call.url).toBe(`https://lifecycle.test/agents/${AGENT_ID}/revoke`);
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^DPoP /);
    expect(headers.DPoP).toBeTruthy();
  });

  it('passes the upstream status through unchanged', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: () => new Response(JSON.stringify({ error: 'agent_already_destroyed' }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }),
    });
    await seedAgent(harness);
    const response = await harness.fetch(`/api/agents/${AGENT_ID}/stop`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'agent_already_destroyed' });
  });

  /**
   * What the person is told, which for this button is the whole of the feedback.
   *
   * A stop destroys the agent, so the screen has no state left to re-read: the
   * ownership guard answers 404 for an agent that is gone, and the reload every other
   * button ends with would race the cleanup and land the person on a JSON refusal for
   * the agent they had just successfully stopped. The answer is shown in place
   * instead — which is only worth anything if it actually says the stop was taken.
   */
  describe('what the button says afterwards', () => {
    const json = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    async function press(answer: Response): Promise<{
      button: FakeElement; status: FakeElement; reloads: () => number;
    }> {
      const document_ = new FakeDocument();
      const root = element(document_, 'body');
      let reloads = 0;
      Object.defineProperty(root, 'location', { value: { reload: () => { reloads += 1; } } });
      root.appendChild(element(document_, 'button', { 'data-action': 'stop', 'data-agent-id': AGENT_ID }));
      root.appendChild(element(document_, 'p', { 'data-field': 'control-status', 'data-status': '' }));
      const button = root.querySelector('button[data-action="stop"]')!;
      const status = root.querySelector('[data-field="control-status"]')!;

      const original = globalThis.fetch;
      globalThis.fetch = (async () => answer) as unknown as typeof fetch;
      try {
        startAgentDetail(root as unknown as Document);
        button.dispatch('click');
        await vi.waitFor(() => { expect(status.textContent).not.toBe(''); });
      } finally {
        globalThis.fetch = original;
      }
      return { button, status, reloads: () => reloads };
    }

    it('says the stop was taken, and leaves the button pressed', async () => {
      const { button, status, reloads } = await press(json({ status: 'stopping' }, 200));
      expect(status.textContent).toBe(STOP_ACCEPTED);
      expect(status.getAttribute('data-status')).toBe('done');
      expect(button.disabled).toBe(true);
      // The message is the whole answer, so nothing may throw it away by re-reading a
      // page the agent no longer has.
      expect(reloads()).toBe(0);
    });

    it('says a refusal in the words of the refusal, and gives the button back', async () => {
      const { button, status, reloads } = await press(json({ error: 'not_found' }, 404));
      expect(status.textContent).toBe('見つかりませんでした。画面を更新してください。');
      expect(status.getAttribute('data-status')).toBe('error');
      expect(button.disabled).toBe(false);
      expect(reloads()).toBe(0);
    });
  });

  it('depends on neither the Cloud Run nor the KMS client', async () => {
    const manifest = JSON.parse(
      execFileSync('cat', ['apps/automation-app/package.json'], { cwd: repoRoot, encoding: 'utf8' }),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).not.toContain('@google-cloud/run');
    expect(Object.keys(manifest.dependencies)).not.toContain('@google-cloud/kms');
  });
});

describe('additional instructions', () => {
  const send = (harness: Awaited<ReturnType<typeof startAutomationApp>>, body: unknown, agentId = AGENT_ID) =>
    harness.fetch(`/api/agents/${agentId}/instructions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  it('ACTIVE agent accepts one instruction', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    const response = await send(harness, { text: '請求書を確認してください' });
    expect(response.status).toBe(201);
    const stored = await harness.documents.queryEqual('agent_instructions', [['agent_id', AGENT_ID]]);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data).toMatchObject({ applied_at: null, created_by: SUBJECT });
  });

  it('refuses an agent that is not ACTIVE', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { status: 'EXPIRED', state: { agent_status: 'EXPIRED' } });
    const response = await send(harness, { text: 'x' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'agent_not_active' });
    expect(await harness.documents.queryEqual('agent_instructions', [['agent_id', AGENT_ID]])).toHaveLength(0);
  });

  it('rejects a body that names a capability', async () => {
    // One property, so there is no name in the request an operator could set to widen
    // what a running agent may do (RULE-13). The schema is the record of that.
    expect(Object.keys(instructionRequestSchema.properties)).toEqual(['text']);
    expect(instructionRequestSchema.additionalProperties).toBe(false);

    const harness = await startAutomationApp();
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    for (const body of [
      { text: 'x', capabilities: ['a'] }, { text: 'x', tools: ['t'] }, { text: 'x', scope: 's' },
      { text: 'x', audience: 'a' }, { text: 'x', url: 'https://evil.test' }, {},
    ]) {
      expect((await send(harness, body)).status).toBe(400);
    }
  });

  it('records the instruction text in the audit line but never a token', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    await send(harness, { text: '経費を集計してください' });
    const lines = harness.auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = lines.find((line) => line.operation === 'add_instruction')!;
    expect(entry.instruction_text).toBe('経費を集計してください');
    for (const line of harness.auditLines) {
      expect(line).not.toContain(harness.session.access_tokens['automation-app']);
      expect(line).not.toContain('DPoP');
    }
  });

  it('emits one line per operation', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    await harness.fetch(`/api/agents/${AGENT_ID}/status`);
    await harness.fetch(`/api/agents/${AGENT_ID}/stop`, { method: 'POST' });
    await send(harness, { text: 'x' });
    const successes = harness.auditLines.map((line) => JSON.parse(line) as { result: string; operation: string })
      .filter((entry) => entry.result === 'success');
    expect(successes.map((entry) => entry.operation).sort()).toEqual([...AUDIT_OPERATIONS].sort());
  });
});
