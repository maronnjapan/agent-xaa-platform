import { TODO_CONTEXT_MAX, TODO_TITLE_MAX } from '@xaa/automation-app/src/schemas/index';
import { readTodoInput } from '@xaa/automation-app/src/work-definition/input';
import { describe, expect, it } from 'vitest';
import type { ReviewTask } from '../src/tasks.js';
import { buildTodoRequest, TaskNotRegisterable } from '../src/todo.js';

const task = (over: Partial<ReviewTask> = {}): ReviewTask => ({
  id: 't1', title: '請求書の様式を確認する', detail: '', priority: 'next',
  owner: '', quote: '', knowledge: '', due: '', ...over,
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

  it('turns when to start the work into how much it matters', () => {
    expect(buildTodoRequest(task({ priority: 'now' }), 'p.md').priority).toBe('high');
    expect(buildTodoRequest(task({ priority: 'next' }), 'p.md').priority).toBe('normal');
    expect(buildTodoRequest(task({ priority: 'later' }), 'p.md').priority).toBe('low');
  });

  it('invents no done criteria, steps or notes', () => {
    const request = buildTodoRequest(task(), 'docs/plan.md');
    expect(request.done_criteria).toEqual([]);
    expect(request.steps).toEqual([]);
    expect(request.notes).toEqual([]);
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
