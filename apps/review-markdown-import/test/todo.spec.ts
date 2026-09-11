import {
  TODO_CONTEXT_MAX, TODO_LIST_ITEM_MAX, TODO_LIST_MAX_ITEMS, TODO_TITLE_MAX,
} from '@xaa/automation-app/src/schemas/index';
import { readTodoInput } from '@xaa/automation-app/src/work-definition/input';
import { describe, expect, it } from 'vitest';
import type { ReviewTask } from '../src/tasks.js';
import { buildTodoRequest, TaskNotRegisterable } from '../src/todo.js';

const task = (over: Partial<ReviewTask> = {}): ReviewTask => ({
  id: 't1', title: '請求書の様式を確認する', detail: '', priority: 'normal',
  owner: '', quote: '', knowledge: '', due: '',
  doneCriteria: [], steps: [], notes: [], ...over,
});

describe('a review task written as a ToDo', () => {
  it('is read by the app that receives it', () => {
    const request = buildTodoRequest(task({ detail: '経理に確認する', due: '2026-09-30' }), 'docs/plan.md');
    const read = readTodoInput({ ...request }, { lifetimeMinutes: 60 });
    expect(read.title).toBe('請求書の様式を確認する');
    expect(read.description).toBe('経理に確認する');
    expect(read.due_on).toBe('2026-09-30');
    // Not given, so the app applied its own default rather than a guess from here.
    expect(read.requested_lifetime_minutes).toBe(60);
  });

  it('sends the priority as it is, because both tools use the same three values', () => {
    expect(buildTodoRequest(task({ priority: 'high' }), 'p.md').priority).toBe('high');
    expect(buildTodoRequest(task({ priority: 'normal' }), 'p.md').priority).toBe('normal');
    expect(buildTodoRequest(task({ priority: 'low' }), 'p.md').priority).toBe('low');
  });

  it('carries the done criteria, steps and notes the reviewer wrote', () => {
    const request = buildTodoRequest(task({
      doneCriteria: ['経理の返事がある'],
      steps: ['経理へ問い合わせる'],
      notes: ['前回の改訂は2024年'],
    }), 'docs/plan.md');
    expect(request.done_criteria).toEqual(['経理の返事がある']);
    expect(request.steps).toEqual(['経理へ問い合わせる']);
    expect(request.notes).toEqual(['前回の改訂は2024年']);
    const read = readTodoInput({ ...request }, { lifetimeMinutes: 60 });
    expect(read.done_criteria).toEqual(['経理の返事がある']);
  });

  it('invents none of them when the reviewer wrote none', () => {
    const request = buildTodoRequest(task(), 'docs/plan.md');
    expect(request.done_criteria).toEqual([]);
    expect(request.steps).toEqual([]);
    expect(request.notes).toEqual([]);
  });

  it('refuses a hand-edited list the ToDo would reject', () => {
    expect(() => buildTodoRequest(task({ steps: Array.from({ length: TODO_LIST_MAX_ITEMS + 1 }, () => 'あ') }), 'p.md'))
      .toThrow(/steps has more than/);
    expect(() => buildTodoRequest(task({ notes: ['あ'.repeat(TODO_LIST_ITEM_MAX + 1)] }), 'p.md'))
      .toThrow(/notes is longer/);
  });

  it('asks for no lifetime, so the app decides how long the work may run', () => {
    expect(Object.keys(buildTodoRequest(task(), 'p.md'))).not.toContain('requested_lifetime_minutes');
  });

  it('omits the due date when the reviewer set none', () => {
    expect(Object.keys(buildTodoRequest(task({ due: '' }), 'p.md'))).not.toContain('due_on');
  });

  it('builds the context from what was written, and nothing else', () => {
    const request = buildTodoRequest(
      task({ owner: '田中', quote: '請求書の様式が古い', knowledge: '前回の改訂は2024年' }),
      'docs/plan.md',
    );
    expect(request.context).toBe([
      '元の文書: docs/plan.md',
      '担当: 田中',
      '引用:\n請求書の様式が古い',
      '参考知識:\n前回の改訂は2024年',
    ].join('\n\n'));
  });

  it('leaves the context empty when the task carries nothing but its title', () => {
    expect(buildTodoRequest(task(), '').context).toBe('');
  });

  it('refuses a task with no title, and one longer than the ToDo allows', () => {
    expect(() => buildTodoRequest(task({ title: '   ' }), 'p.md')).toThrow(TaskNotRegisterable);
    expect(() => buildTodoRequest(task({ title: 'あ'.repeat(TODO_TITLE_MAX + 1) }), 'p.md')).toThrow(/title is longer/);
    expect(() => buildTodoRequest(task({ knowledge: 'あ'.repeat(TODO_CONTEXT_MAX + 1) }), 'p.md')).toThrow(/context is longer/);
  });
});
