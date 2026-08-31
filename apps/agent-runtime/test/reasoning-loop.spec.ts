import { describe, expect, it, beforeEach } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ID_JAG_TOKEN_TYPE, drainActivityQueueForTesting, resetActivityPublisherForTesting } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { MAX_REASONING_STEPS, runReasoningLoop } from '../src/reasoning/loop.js';
import { readPendingInstructions } from '../src/instructions/read-pending.js';
import { createRuntimeStore } from '../src/store/runtime-store.js';
import { createExecutionContext } from '../src/context/execution-context.js';
import { AGENT_ID, AGENT_OP, DOCS_AS, docsManifest, fakeIdToken, json, logContext, runtimeEnv, silentLogger, testHttp } from './helpers.js';

function happy(url: string): Response {
  if (url.startsWith(`${AGENT_OP}/xaa/subject-token`)) return json({ id_token: fakeIdToken() });
  if (url.startsWith(`${AGENT_OP}/xaa/token`)) return json({ access_token: 'i.j.k', issued_token_type: ID_JAG_TOKEN_TYPE, expires_in: 300 });
  if (url.startsWith(`${DOCS_AS}/token`)) return json({ access_token: 'a.t', token_type: 'DPoP', expires_in: 300 });
  return json({ documents: [{ document_id: 'd1', title: 'T' }] });
}

async function harness(input: { steps: Array<Record<string, unknown>>; agentId?: string } ) {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
  const store = createRuntimeStore({ documents, agentId: input.agentId ?? AGENT_ID });
  const context = await createExecutionContext({ env: await runtimeEnv(), store, processEnv: {} });
  const { http, calls } = testHttp(context, happy);
  let index = 0;
  const vertex = { generateJson: async <T>() => (input.steps[index++] ?? { done: true }) as T };
  return { context, http, calls, vertex, documents, store };
}

describe('the reasoning loop', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  it('executes the tool the model chose and stops when it says done', async () => {
    const { context, http, vertex } = await harness({
      steps: [{ done: false, tool_call: { tool_id: 'internal.document.list', parameters: {} } }, { done: true }],
    });
    const result = await runReasoningLoop({ context, http, logger: silentLogger, logContext, vertex, stageWrite: () => {} });
    expect(result.stoppedBy).toBe('done');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ outcome: 'success' });
  });

  it('stops at MAX_REASONING_STEPS', async () => {
    const steps = Array.from({ length: 20 }, () => ({ done: false, tool_call: { tool_id: 'internal.document.list', parameters: {} } }));
    const { context, http, vertex } = await harness({ steps });
    const result = await runReasoningLoop({ context, http, logger: silentLogger, logContext, vertex, stageWrite: () => {} });
    expect(result.stoppedBy).toBe('reasoning_step_limit');
    expect(result.results).toHaveLength(MAX_REASONING_STEPS);
    expect(MAX_REASONING_STEPS).toBe(8);
  });

  it('checkpoints each step without leaking a token', async () => {
    const { context, http, vertex, documents } = await harness({
      steps: [{ done: false, tool_call: { tool_id: 'internal.document.list', parameters: {} } }, { done: true }],
    });
    await runReasoningLoop({ context, http, logger: silentLogger, logContext, vertex, stageWrite: () => {} });
    const state = await documents.get('agents', `${AGENT_ID}__state`);
    expect(state).toMatchObject({ agent_status: 'ACTIVE' });
    expect(JSON.stringify(state)).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./);
    // Only the projection reaches the conversation, never the raw body.
    expect(JSON.stringify(state)).not.toContain('"secret"');
  });

  it('records a rejected instruction and makes no agent op call', async () => {
    const { context, http, calls, vertex, documents } = await harness({
      steps: [{ done: false, tool_call: { tool_id: 'internal.finance.payment.approve', parameters: {} } }, { done: true }],
    });
    const result = await runReasoningLoop({ context, http, logger: silentLogger, logContext, vertex, stageWrite: () => {} });
    expect(result.results[0]).toMatchObject({ reason: 'not_in_allowed_tools' });
    expect(calls).toHaveLength(0);
    const state = await documents.get<{ execution_state: { rejected_instruction: unknown[] } }>('agents', `${AGENT_ID}__state`);
    expect(state!.execution_state.rejected_instruction).toHaveLength(1);
  });

  it('treats an unusable model answer as invalid_tool_call', async () => {
    const { context, http, vertex } = await harness({ steps: [{ done: false, tool_call: { tool_id: 42 } }, { done: true }] });
    const result = await runReasoningLoop({ context, http, logger: silentLogger, logContext, vertex, stageWrite: () => {} });
    expect(result.results[0]).toMatchObject({ error_code: 'invalid_tool_call' });
  });
});

describe('pending instructions', () => {
  it('same instruction is not applied twice', async () => {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
    const store = createRuntimeStore({ documents, agentId: AGENT_ID });
    await documents.set('agent_instructions', 'i1', { agent_id: AGENT_ID, body: '請求書を確認して', created_at: '2026-01-01T00:00:00Z', applied_at: null });

    expect(await readPendingInstructions(store, '2026-01-02T00:00:00Z')).toEqual([
      { role: 'user', source: 'instruction', instruction_id: 'i1', body: '請求書を確認して' },
    ]);
    expect(await readPendingInstructions(store, '2026-01-02T00:00:01Z')).toEqual([]);
  });

  it('orders by created_at', async () => {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
    const store = createRuntimeStore({ documents, agentId: AGENT_ID });
    await documents.set('agent_instructions', 'later', { agent_id: AGENT_ID, body: 'b', created_at: '2026-01-02T00:00:00Z', applied_at: null });
    await documents.set('agent_instructions', 'earlier', { agent_id: AGENT_ID, body: 'a', created_at: '2026-01-01T00:00:00Z', applied_at: null });
    expect((await readPendingInstructions(store, 'now')).map((entry) => entry.instruction_id)).toEqual(['earlier', 'later']);
  });

  it('concurrent readers do not double-apply', async () => {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
    const store = createRuntimeStore({ documents, agentId: AGENT_ID });
    await documents.set('agent_instructions', 'i1', { agent_id: AGENT_ID, body: 'x', created_at: '2026-01-01T00:00:00Z', applied_at: null });
    const [first, second] = await Promise.all([
      readPendingInstructions(store, 'now'),
      readPendingInstructions(store, 'now'),
    ]);
    expect(first.length + second.length).toBe(1);
  });

  it('reads only its own agent', async () => {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
    const store = createRuntimeStore({ documents, agentId: AGENT_ID });
    await documents.set('agent_instructions', 'other', { agent_id: 'agent-zzzzzzzzzzzzzzzzzzzzzzzzzz', body: 'x', created_at: '2026-01-01T00:00:00Z', applied_at: null });
    expect(await readPendingInstructions(store, 'now')).toEqual([]);
  });

  it('takes them into the conversation once per execution', async () => {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
    const store = createRuntimeStore({ documents, agentId: AGENT_ID });
    await documents.set('agent_instructions', 'i1', { agent_id: AGENT_ID, body: '追加の指示', created_at: '2026-01-01T00:00:00Z', applied_at: null });
    const context = await createExecutionContext({ env: await runtimeEnv(), store, processEnv: {} });
    const { http } = testHttp(context, happy);
    let index = 0;
    const steps = [{ done: false, tool_call: { tool_id: 'internal.document.list', parameters: {} } }, { done: true }];
    const vertex = { generateJson: async <T>() => (steps[index++] ?? { done: true }) as T };
    await runReasoningLoop({ context, http, logger: silentLogger, logContext, vertex, stageWrite: () => {} });
    const state = await documents.get<{ conversation_context: Array<{ source?: string }> }>('agents', `${AGENT_ID}__state`);
    expect(state!.conversation_context.filter((entry) => entry.source === 'instruction')).toHaveLength(1);
  });

  it('is called from one place only', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const hits: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = await readFile(full, 'utf8');
        if (text.includes('readPendingInstructions(')) hits.push(full);
      }
    };
    await walk(root);
    // The definition in the store, its wrapper, and the single call in loop.ts.
    expect(hits.map((hit) => hit.split('/src/')[1]).sort())
      .toEqual(['instructions/read-pending.ts', 'reasoning/loop.ts', 'store/runtime-store.ts']);
  });

  it('never asks the Provisioner for more permission', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const walk = async (path: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) out.push(...await walk(full));
        else if (entry.name.endsWith('.ts')) out.push(await readFile(full, 'utf8'));
      }
      return out;
    };
    for (const text of await walk(root)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code.toLowerCase()).not.toContain('provisioner');
    }
  });

  it('leaves the manifest hash unchanged across an execution', async () => {
    const env = await runtimeEnv();
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
    const store = createRuntimeStore({ documents, agentId: AGENT_ID });
    const context = await createExecutionContext({ env, store, processEnv: {} });
    const { http } = testHttp(context, happy);
    const before = JSON.stringify(context.manifest);
    let index = 0;
    const steps = [{ done: false, tool_call: { tool_id: 'internal.finance.payment.approve', parameters: {} } }, { done: true }];
    await runReasoningLoop({
      context, http, logger: silentLogger, logContext, stageWrite: () => {},
      vertex: { generateJson: async <T>() => (steps[index++] ?? { done: true }) as T },
    });
    expect(JSON.stringify(context.manifest)).toBe(before);
    expect(context.manifest.tools.map((tool) => tool.tool_id)).toEqual(docsManifest().tools.map((tool) => tool.tool_id));
  });
});

describe('the drained activity queue', () => {
  it('starts empty for each spec', () => {
    resetActivityPublisherForTesting();
    expect(drainActivityQueueForTesting()).toEqual([]);
  });
});
