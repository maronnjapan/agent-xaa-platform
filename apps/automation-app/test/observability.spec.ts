import { describe, expect, it } from 'vitest';
import { FAULT_KINDS } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { AGENT_ID, SUBJECT, seedAgent, startAutomationApp } from './helpers.js';

const postFault = (h: Awaited<ReturnType<typeof startAutomationApp>>, body: unknown = { kind: 'runtime_crash' }, agent = AGENT_ID) =>
  h.fetch(`/api/agents/${agent}/faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('fault injection authorization and lifecycle', () => {
  it('is disabled by default and hidden on the page', async () => {
    const h = await startAutomationApp();
    await seedAgent(h);
    expect((await postFault(h)).status).toBe(404);
    expect(await (await h.fetch(`/agents/${AGENT_ID}`)).text()).not.toContain('data-action="inject-fault"');
  });
  it('binds a single request to the owned current task and audits it', async () => {
    const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' } } });
    expect((await postFault(h)).status).toBe(202);
    expect((await postFault(h)).status).toBe(409);
    const rows = await h.documents.queryEqual('agent_instructions', [['agent_id', AGENT_ID]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ created_by: SUBJECT, applied_at: null, fault: { kind: 'runtime_crash', task_id: 'task-1' } });
    expect(h.auditLines.some((line) => JSON.parse(line).operation === 'fault_injection')).toBe(true);
    expect((await postFault(h, { kind: 'runtime_crash', task_id: 'another-task' })).status).toBe(400);
    expect((await postFault(h, { kind: 'arbitrary_command' })).status).toBe(400);
  });
  it('rejects strangers, expired agents and stale ACTIVE checkpoints after revocation', async () => {
    const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
    await seedAgent(h, { humanSubject: 'another-person' });
    expect((await postFault(h)).status).toBe(404);
    await seedAgent(h, { status: 'REVOKED', state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' } } });
    expect((await postFault(h)).status).toBe(409);
    expect(await (await h.fetch(`/api/agents/${AGENT_ID}/status`)).json()).toMatchObject({ agent_status: 'REVOKED' });
    await seedAgent(h, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await postFault(h)).status).toBe(409);
    expect((await h.fetch(`/api/agents/${AGENT_ID}/faults`, { method: 'POST', headers: { cookie: '' } })).status).toBe(401);
  });
});

describe('the three kinds of failure', () => {
  it('accepts each kind, carries it on the trial, and offers all three on the page', async () => {
    for (const kind of FAULT_KINDS) {
      const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
      await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' } } });
      expect((await postFault(h, { kind })).status).toBe(202);
      const monitor = await (await h.fetch(`/api/agents/${AGENT_ID}/monitor`)).json() as { faultTrials: Array<{ kind: string; state: string }> };
      expect(monitor.faultTrials).toEqual([expect.objectContaining({ kind, state: 'queued' })]);
      const page = await (await h.fetch(`/agents/${AGENT_ID}`)).text();
      for (const offered of FAULT_KINDS) expect(page).toContain(`data-fault-kind="${offered}"`);
      expect(page).toContain(`data-trial-kind="${kind}"`);
      expect(page).toContain('data-trial-tracker=');
    }
  });

  it('confirms a fault the execution survived from the request id alone', async () => {
    const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' } } });
    const request = await (await postFault(h, { kind: 'tool_failure' })).json() as { instruction_id: string };
    await h.documents.update('agent_instructions', request.instruction_id, { applied_at: new Date().toISOString() });
    // The Runtime wrote down which request it applied and no execution failure,
    // because a failed tool call is a step of the run, not the end of it.
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' },
      execution_state: { fault_instruction_id: request.instruction_id, fault_kind: 'tool_failure' } } });
    const view = await (await h.fetch(`/api/agents/${AGENT_ID}/status-view`)).text();
    expect(view).toContain('data-trial-state="failed"');
    expect(view).toContain('ツール呼び出しの失敗を確認');
    expect(view).toContain('data-step-state="done"');
    expect(await (await h.fetch(`/api/agents/${AGENT_ID}/status`)).json()).toMatchObject({ execution_failure: null, current_task: 'task-1' });
  });

  it('names an unanswered model as its own failure on the page', async () => {
    const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { agent_id: AGENT_ID },
      execution_state: { failure: 'injected_model_unavailable' } } });
    const page = await (await h.fetch(`/agents/${AGENT_ID}`)).text();
    expect(page).toContain('data-failure="injected_model_unavailable"');
    expect(page).toContain('モデルを呼ばずに');
  });
});

describe('how a failed execution is reported', () => {
  it('names the failure without inventing a Lifecycle state, and echoes nothing else', async () => {
    const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
    // The checkpoint a crashed execution leaves behind: the agent is still ACTIVE,
    // because a Runtime does not move an agent through the Lifecycle (docs 07 §2).
    await seedAgent(h, { state: {
      agent_status: 'ACTIVE', task_context: { agent_id: AGENT_ID },
      execution_state: { failure: 'injected_runtime_crash' },
    } });
    const status = await (await h.fetch(`/api/agents/${AGENT_ID}/status`)).json();
    expect(status).toMatchObject({
      agent_status: 'ACTIVE', current_task: null, execution_failure: 'injected_runtime_crash',
    });
    const page = await (await h.fetch(`/agents/${AGENT_ID}`)).text();
    expect(page).toContain('data-failure="injected_runtime_crash"');
    expect(page).toContain('直近の実行は失敗しました');

    // `execution_state` is the Runtime's own scratch space. Only a value on the closed
    // list reaches the browser, so a checkpoint field cannot become a message.
    await seedAgent(h, { state: {
      agent_status: 'ACTIVE', task_context: { task_id: 'task-1' },
      execution_state: { failure: 'https://attacker.test/?leaked=secret' },
    } });
    const bogus = await (await h.fetch(`/api/agents/${AGENT_ID}/status`)).json();
    expect(bogus).toMatchObject({ execution_failure: null, current_task: 'task-1' });
    expect(await (await h.fetch(`/agents/${AGENT_ID}`)).text()).not.toContain('attacker.test');
  });
});

describe('analysis monitoring privacy', () => {
  it('serves only the session subject and projects known fields in API and HTML', async () => {
    const shared = createFirestoreDouble();
    const writer = createFirestoreDocumentStore(shared, 'security-detection');
    const base = { started_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:01Z',
      status: 'completed', stage: 'respond', completed_stages: [], input_count: 1, normalized_count: 1,
      unmapped_count: 0, violation_count: 0, rule_hit_count: 0, decisions: [], error_code: null };
    await writer.set('security_analysis', 'own', { ...base, run_id: 'own', human_subject: SUBJECT, raw_log: 'private-credential' });
    await writer.set('security_analysis', 'other', { ...base, run_id: 'other-private', human_subject: 'another-person' });
    const h = await startAutomationApp({ shared });
    for (const path of ['/api/security/analysis?human_subject=another-person', '/api/security/analysis-view', '/security']) {
      const response = await h.fetch(path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('own');
      expect(text).not.toMatch(/other-private|another-person|private-credential|raw_log/);
    }
    expect((await h.fetch('/api/security/analysis', { headers: { cookie: '' } })).status).toBe(401);
    expect((await h.fetch('/security', { headers: { cookie: '' } })).status).toBe(302);
  });
});


describe('fault trial progress', () => {
  it('ties confirmation to the exact request and preserves it when the task ends', async () => {
    const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' } } });
    const request = await (await postFault(h)).json() as { instruction_id: string };
    const view = () => h.fetch(`/api/agents/${AGENT_ID}/status-view`).then((r) => r.text());
    expect(await view()).toContain('data-trial-state="queued"');
    await h.documents.update('agent_instructions', request.instruction_id, { applied_at: new Date().toISOString() });
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: {},
      execution_state: { failure: 'injected_runtime_crash', fault_instruction_id: 'another-request' } } });
    expect(await view()).toContain('data-trial-state="received"');
    expect(await view()).not.toContain('data-trial-state="failed"');
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: {},
      execution_state: { failure: 'injected_runtime_crash', fault_instruction_id: request.instruction_id } } });
    expect(await view()).toContain('data-trial-state="failed"');
    expect(await view()).toContain('実行の失敗を確認');
    expect((await h.fetch(`/api/agents/${AGENT_ID}/status-view`, { headers: { cookie: '' } })).status).toBe(401);
    await seedAgent(h, { humanSubject: 'another-person' });
    expect((await h.fetch(`/api/agents/${AGENT_ID}/status-view`)).status).toBe(404);
  });

  it('shows an unapplied request after its task ends without blocking a new task', async () => {
    const h = await startAutomationApp({ config: { faultInjectionEnabled: true } });
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-1' } } });
    expect((await postFault(h)).status).toBe(202);
    await seedAgent(h, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-2' } } });
    const html = await (await h.fetch(`/agents/${AGENT_ID}`)).text();
    expect(html).toContain('data-trial-state="not_applied"');
    expect((await postFault(h)).status).toBe(202);
    expect((await postFault(h)).status).toBe(409);
  });
});

it('projects score contributions and timing without forwarding nested private fields', async () => {
  const shared = createFirestoreDouble();
  const writer = createFirestoreDocumentStore(shared, 'security-detection');
  await writer.set('security_analysis', 'explained', {
    run_id: 'explained', human_subject: SUBJECT,
    started_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:04Z',
    stage_started_at: '2026-09-09T00:00:01Z', stage_durations_ms: { collect: 1000, analyze: 3000, secret: 'private-time' },
    status: 'completed', stage: 'respond', completed_stages: ['collect', 'analyze', 'respond'],
    input_count: 1, normalized_count: 1, unmapped_count: 0, violation_count: 1, rule_hit_count: 1, error_code: null,
    decisions: [{ finding_id: 'f-1', agent_id: AGENT_ID, codes: ['invalid_scope'], score: 45, level: 'MEDIUM',
      state: 'skipped', reason: 'baseline_missing', response: null, confidence: null, transition: null,
      score_breakdown: { critical_override: false, unmapped_count: 0, prompt: 'private-prompt',
        contributions: [{ factor: 'authorization_violation', count: 4, per_event: 15, cap: 45, points: 45, raw_log: 'private-evidence' }] },
    }],
  });
  const h = await startAutomationApp({ shared });
  for (const path of ['/api/security/analysis', '/api/security/analysis-view', '/security']) {
    const response = await h.fetch(path);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/private-time|private-prompt|private-evidence|raw_log/);
    if (path === '/api/security/analysis') {
      const data = JSON.parse(text);
      expect(data.runs[0].stage_durations_ms).toEqual({ collect: 1000, analyze: 3000 });
      expect(data.runs[0].decisions[0].score_breakdown.contributions[0]).toEqual({
        factor: 'authorization_violation', count: 4, per_event: 15, cap: 45, points: 45,
      });
    } else {
      expect(text).toContain('スコアの算出根拠');
      expect(text).toContain('1.0 秒');
      expect(text).toContain('比較基準がないためAI分析を省略');
    }
  }
});
