import { describe, expect, it } from 'vitest';
import {
  cancel, compareTodos, complete, confirm, isOpen, startExecution, TodoClosed, TodoNotDraft, type WorkDefinition,
} from '../src/work-definition/model.js';
import { InvalidTodoInput, readTodoInput } from '../src/work-definition/input.js';
import { LifetimeOutOfRange } from '../src/work-definition/lifetime.js';
import { buildInitialInstruction } from '../src/agents/initial-instruction.js';
import { AGENT_ID, SUBJECT, seedAgent, startAutomationApp, type Harness } from './helpers.js';

/**
 * A ToDo's life: written, confirmed, carried out by an agent, and closed by a person.
 *
 * The states are the app's own and every move between them is a person's act. What
 * these fix is that nothing else moves them — not the model, not the agent's verdict,
 * not a second confirm — and that the list a person reads is ordered the way they
 * would order it themselves.
 */

const todo: WorkDefinition = {
  work_definition_id: 'wd_1', human_subject: SUBJECT, status: 'DRAFT',
  title: '経費の申請書を確認する', description: '未処理の申請書を読み、金額を確かめる',
  context: '申請書は経理フォルダの「未処理」にある。10万円を超えるものは上長の確認が要る。',
  done_criteria: ['未処理の申請書がすべて読まれている', '10万円超の一覧が書かれている'],
  steps: ['申請書の一覧を開く', '金額を確かめる'], notes: ['承認はしない'],
  priority: 'normal', due_on: null, requested_lifetime_minutes: 60, source: 'screen', agent_id: null,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', completed_at: null,
};
const at = '2026-01-02T00:00:00.000Z';

async function seedTodo(harness: Harness, overrides: Partial<WorkDefinition> = {}): Promise<string> {
  const row = { ...todo, ...overrides };
  await harness.documents.set('work_definitions', row.work_definition_id, row as unknown as Record<string, unknown>);
  return row.work_definition_id;
}

describe('the transitions', () => {
  it('confirms a draft once, and refuses everything that is not a draft', () => {
    const confirmed = confirm(todo, at);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', updated_at: at });
    for (const status of ['CONFIRMED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const) {
      expect(() => confirm({ ...todo, status }, at)).toThrow(TodoNotDraft);
    }
  });

  it('records the agent and reads as in progress, from any open state', () => {
    const started = startExecution({ ...todo, status: 'CONFIRMED' }, AGENT_ID, at);
    expect(started).toMatchObject({ status: 'IN_PROGRESS', agent_id: AGENT_ID });
    expect(() => startExecution({ ...todo, status: 'DONE' }, AGENT_ID, at)).toThrow(TodoClosed);
  });

  it('closes an open ToDo once, either way, and stamps when', () => {
    for (const status of ['DRAFT', 'CONFIRMED', 'IN_PROGRESS'] as const) {
      expect(complete({ ...todo, status }, at)).toMatchObject({ status: 'DONE', completed_at: at });
      expect(cancel({ ...todo, status }, at)).toMatchObject({ status: 'CANCELLED', completed_at: at });
    }
    for (const status of ['DONE', 'CANCELLED'] as const) {
      expect(isOpen({ status })).toBe(false);
      expect(() => complete({ ...todo, status }, at)).toThrow(TodoClosed);
      expect(() => cancel({ ...todo, status }, at)).toThrow(TodoClosed);
    }
  });

  it('is pure: the ToDo handed in is not the one handed back', () => {
    const before = { ...todo };
    complete(todo, at);
    expect(todo).toEqual(before);
  });
});

describe('the order of the list', () => {
  const make = (overrides: Partial<WorkDefinition>): WorkDefinition => ({ ...todo, ...overrides });

  it('puts open ToDos first, urgent ones on top, closed ones last by when they closed', () => {
    const rows = [
      make({ work_definition_id: 'done-early', status: 'DONE', completed_at: '2026-01-05T00:00:00.000Z' }),
      make({ work_definition_id: 'low', priority: 'low' }),
      make({ work_definition_id: 'normal-later', due_on: '2026-02-01' }),
      make({ work_definition_id: 'done-late', status: 'CANCELLED', completed_at: '2026-01-09T00:00:00.000Z' }),
      make({ work_definition_id: 'high', priority: 'high' }),
      make({ work_definition_id: 'normal-soon', due_on: '2026-01-20' }),
      make({ work_definition_id: 'normal-none-old', created_at: '2025-12-01T00:00:00.000Z' }),
      make({ work_definition_id: 'normal-none-new', created_at: '2026-01-15T00:00:00.000Z' }),
    ];
    expect([...rows].sort(compareTodos).map((row) => row.work_definition_id)).toEqual([
      'high', 'normal-soon', 'normal-later', 'normal-none-new', 'normal-none-old', 'low', 'done-late', 'done-early',
    ]);
  });
});

describe('reading a ToDo body', () => {
  const defaults = { lifetimeMinutes: 60 };

  it('takes lists as arrays or as lines, and fills what was not written', () => {
    const read = readTodoInput({
      title: '  日報  ', description: '前日の記録から', context: undefined,
      done_criteria: '日報がある\n\n  保存されている  ', steps: ['読む', '', 'まとめる'], notes: null,
    }, defaults);
    expect(read).toEqual({
      title: '日報', description: '前日の記録から', context: '',
      done_criteria: ['日報がある', '保存されている'], steps: ['読む', 'まとめる'], notes: [],
      priority: 'normal', due_on: null, requested_lifetime_minutes: 60,
    });
  });

  it('refuses what would make the record unusable, by name', () => {
    expect(() => readTodoInput({}, defaults)).toThrow(InvalidTodoInput);
    expect(() => readTodoInput({ title: '   ' }, defaults)).toThrow(expect.objectContaining({ code: 'title_required' }));
    expect(() => readTodoInput({ title: 'x', priority: 'urgent' }, defaults)).toThrow(expect.objectContaining({ code: 'invalid_priority' }));
    for (const due_on of ['2026/01/01', '2026-13-01', '2026-02-30', 'tomorrow', 20260101]) {
      expect(() => readTodoInput({ title: 'x', due_on }, defaults)).toThrow(expect.objectContaining({ code: 'invalid_due_on' }));
    }
    expect(() => readTodoInput({ title: 'x'.repeat(201) }, defaults)).toThrow(expect.objectContaining({ code: 'text_too_long' }));
    expect(() => readTodoInput({ title: 'x', steps: ['y'.repeat(501)] }, defaults)).toThrow(expect.objectContaining({ code: 'text_too_long' }));
    expect(() => readTodoInput({ title: 'x', notes: Array.from({ length: 51 }, () => 'n') }, defaults)).toThrow(expect.objectContaining({ code: 'too_many_items' }));
    expect(() => readTodoInput({ title: 'x', requested_lifetime_minutes: 0 }, defaults)).toThrow(LifetimeOutOfRange);
  });

  it('accepts a real day and each of the three priorities', () => {
    expect(readTodoInput({ title: 'x', due_on: '2026-02-28', priority: 'low' }, defaults)).toMatchObject({ due_on: '2026-02-28', priority: 'low' });
    expect(readTodoInput({ title: 'x', priority: 'high' }, defaults).priority).toBe('high');
  });

  it('never reads the fields the app writes itself', () => {
    const read = readTodoInput({ title: 'x', status: 'DONE', agent_id: 'agent-x', source: 'api', human_subject: 'someone-else' }, defaults) as Record<string, unknown>;
    expect(read).not.toHaveProperty('status');
    expect(read).not.toHaveProperty('agent_id');
    expect(read).not.toHaveProperty('source');
    expect(read).not.toHaveProperty('human_subject');
  });
});

describe('the first instruction', () => {
  it('carries the context and the done criteria, and only the sections that have words', () => {
    const text = buildInitialInstruction({ ...todo, status: 'CONFIRMED', priority: 'high', due_on: '2026-01-31' });
    expect(text.split('\n')).toEqual([
      'これがあなたに任された ToDo です。使用できるツールの範囲で進め、完了条件を満たしたら作業を終えてください。',
      'タイトル: 経費の申請書を確認する',
      '内容:', '未処理の申請書を読み、金額を確かめる',
      '背景と前提（実行時のコンテキスト）:', '申請書は経理フォルダの「未処理」にある。10万円を超えるものは上長の確認が要る。',
      '完了条件:', '- 未処理の申請書がすべて読まれている', '- 10万円超の一覧が書かれている',
      '手順:', '- 申請書の一覧を開く', '- 金額を確かめる',
      '注意点:', '- 承認はしない',
      '優先度: 高',
      '期限: 2026-01-31',
    ]);
    const bare = buildInitialInstruction({ ...todo, description: '', context: '', done_criteria: [], steps: [], notes: [] });
    expect(bare).not.toContain('内容:');
    expect(bare).not.toContain('完了条件:');
    expect(bare).not.toContain('期限:');
    expect(bare).toContain('優先度: 中');
  });
});

describe('the routes that close a ToDo', () => {
  it('marks a confirmed ToDo done, and refuses to do it twice', async () => {
    const harness = await startAutomationApp({ now: () => Date.parse(at) });
    const id = await seedTodo(harness, { status: 'CONFIRMED' });
    const done = await harness.fetch(`/api/todos/${id}/complete`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'DONE', completed_at: at });
    const again = await harness.fetch(`/api/todos/${id}/complete`, { method: 'POST' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'todo_closed' });
    expect((await harness.fetch(`/api/todos/${id}/cancel`, { method: 'POST' })).status).toBe(409);
  });

  it('withdraws a draft, and refuses to confirm or rewrite it afterwards', async () => {
    const harness = await startAutomationApp();
    const id = await seedTodo(harness);
    expect((await harness.fetch(`/api/todos/${id}/cancel`, { method: 'POST' })).status).toBe(200);
    expect((await harness.fetch(`/api/todos/${id}/confirm`, { method: 'POST' })).status).toBe(409);
    const stored = await harness.documents.get<{ status: string }>('work_definitions', id);
    expect(stored?.status).toBe('CANCELLED');
  });

  it('refuses to withdraw a ToDo whose agent is still running, and allows it once stopped', async () => {
    const harness = await startAutomationApp();
    const id = await seedTodo(harness, { status: 'IN_PROGRESS', agent_id: AGENT_ID });
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    const running = await harness.fetch(`/api/todos/${id}/cancel`, { method: 'POST' });
    expect(running.status).toBe(409);
    expect(await running.json()).toEqual({ error: 'agent_still_running' });
    expect((await harness.documents.get<{ status: string }>('work_definitions', id))?.status).toBe('IN_PROGRESS');

    await seedAgent(harness, { status: 'REVOKED', state: { agent_status: 'REVOKED' } });
    expect((await harness.fetch(`/api/todos/${id}/cancel`, { method: 'POST' })).status).toBe(200);
  });

  it('lets a person mark a ToDo done while its agent runs: the agent is theirs to stop', async () => {
    const harness = await startAutomationApp();
    const id = await seedTodo(harness, { status: 'IN_PROGRESS', agent_id: AGENT_ID });
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    expect((await harness.fetch(`/api/todos/${id}/complete`, { method: 'POST' })).status).toBe(200);
  });

  it("answers 404 for someone else's ToDo, and writes nothing", async () => {
    const harness = await startAutomationApp();
    const id = await seedTodo(harness, { human_subject: 'someone-else' });
    for (const action of ['complete', 'cancel', 'confirm']) {
      const response = await harness.fetch(`/api/todos/${id}/${action}`, { method: 'POST' });
      expect(response.status).toBe(404);
    }
    expect((await harness.fetch(`/api/todos/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'stolen' }),
    })).status).toBe(404);
    expect((await harness.documents.get<{ status: string; title: string }>('work_definitions', id))).toMatchObject({ status: 'DRAFT', title: todo.title });
  });
});

describe('editing a draft by hand', () => {
  it('writes the fields the form carries and nothing the app owns', async () => {
    const harness = await startAutomationApp({ now: () => Date.parse(at) });
    const id = await seedTodo(harness);
    const response = await harness.fetch(`/api/todos/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '申請書を確認して一覧を作る', context: '経理フォルダの「未処理」', priority: 'high', due_on: '2026-01-31',
        done_criteria: ['一覧がある'], steps: [], notes: ['承認はしない'], requested_lifetime_minutes: 30,
        status: 'DONE', agent_id: 'agent-x', source: 'api', human_subject: 'someone-else',
      }),
    });
    expect(response.status).toBe(200);
    const stored = await harness.documents.get<WorkDefinition>('work_definitions', id);
    expect(stored).toMatchObject({
      title: '申請書を確認して一覧を作る', description: '', context: '経理フォルダの「未処理」', priority: 'high', due_on: '2026-01-31',
      done_criteria: ['一覧がある'], steps: [], notes: ['承認はしない'], requested_lifetime_minutes: 30,
      status: 'DRAFT', agent_id: null, source: 'screen', human_subject: SUBJECT, updated_at: at,
    });
  });

  it('refuses once the wording is settled, and refuses a bad body by name', async () => {
    const harness = await startAutomationApp();
    const confirmedId = await seedTodo(harness, { work_definition_id: 'wd_c', status: 'CONFIRMED' });
    const settled = await harness.fetch(`/api/todos/${confirmedId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    });
    expect(settled.status).toBe(409);
    expect(await settled.json()).toEqual({ error: 'todo_not_draft' });

    const draftId = await seedTodo(harness);
    const untitled = await harness.fetch(`/api/todos/${draftId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '' }),
    });
    expect(untitled.status).toBe(400);
    expect(await untitled.json()).toEqual({ error: 'title_required' });
    expect((await harness.documents.get<{ title: string }>('work_definitions', draftId))?.title).toBe(todo.title);
  });
});

describe('registering from the screen', () => {
  it('refuses a body with no title, and a due date that is not a day, by name', async () => {
    const harness = await startAutomationApp();
    const untitled = await harness.fetch('/api/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'x' }),
    });
    expect(untitled.status).toBe(400);
    expect(await untitled.json()).toEqual({ error: 'title_required' });
    const badDay = await harness.fetch('/api/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', due_on: '来週' }),
    });
    expect(await badDay.json()).toEqual({ error: 'invalid_due_on' });
  });
});
