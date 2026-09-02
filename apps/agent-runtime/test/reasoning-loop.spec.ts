import { describe, expect, it, beforeEach } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ID_JAG_TOKEN_TYPE, drainActivityQueueForTesting, resetActivityPublisherForTesting } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { MAX_REASONING_STEPS, runReasoningLoop } from '../src/reasoning/loop.js';
import { readPendingInstructions } from '../src/instructions/read-pending.js';
import { createRuntimeStore } from '../src/store/runtime-store.js';
import { createExecutionContext } from '../src/context/execution-context.js';
import { AGENT_ID, AGENT_OP, DOCS_AS, fakeIdToken, json, logContext, runtimeEnv, silentLogger, testHttp } from './helpers.js';

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

  // The refusal of an out-of-permission step, what it records and the manifest hash
  // that proves nothing was widened live in instruction-guard.spec.ts (T-RUN-23).

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

  it('no update outside transaction', async () => {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
    // Every direct write to the instructions collection is counted; the ones the
    // transaction makes go through its own handle and are not seen here.
    let directWrites = 0;
    let seeded = false;
    const counted = {
      ...documents,
      update: async (collection: string, id: string, patch: Record<string, unknown>) => {
        if (collection === 'agent_instructions') directWrites += 1;
        return documents.update(collection, id, patch);
      },
      set: async (collection: string, id: string, value: Record<string, unknown>) => {
        if (collection === 'agent_instructions' && seeded) directWrites += 1;
        return documents.set(collection, id, value);
      },
    } as typeof documents;
    await documents.set('agent_instructions', 'i1', { agent_id: AGENT_ID, body: 'x', created_at: '2026-01-01T00:00:00Z', applied_at: null });
    seeded = true;

    const store = createRuntimeStore({ documents: counted, agentId: AGENT_ID });
    expect(await readPendingInstructions(store, '2026-01-02T00:00:00Z')).toHaveLength(1);
    expect(directWrites).toBe(0);
    // The stamp really was written — inside the transaction, which is why a second
    // read finds nothing left to apply.
    expect(await readPendingInstructions(store, '2026-01-02T00:00:01Z')).toEqual([]);

    // And the store offers no update-only door to reach around the transaction.
    const source = await readFile(new URL('../src/store/runtime-store.ts', import.meta.url), 'utf8');
    expect(source.match(/\.update\(/g)).toHaveLength(1);
    expect(source).toContain('tx.update(');
  });
});

describe('the drained activity queue', () => {
  it('starts empty for each spec', () => {
    resetActivityPublisherForTesting();
    expect(drainActivityQueueForTesting()).toEqual([]);
  });
});
