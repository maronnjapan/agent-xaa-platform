import {
  DUE_ON_PATTERN, TODO_CONTEXT_MAX, TODO_LIST_ITEM_MAX, TODO_LIST_MAX_ITEMS, TODO_PRIORITY_VALUES,
  TODO_TEXT_MAX, TODO_TITLE_MAX,
} from '../schemas/index.js';
import { validateLifetimeMinutes } from './lifetime.js';
import type { TodoPriority } from './model.js';

/** The fields a person or their API client writes for one ToDo. */
export interface TodoInput {
  title: string;
  description: string;
  context: string;
  done_criteria: string[];
  steps: string[];
  notes: string[];
  priority: TodoPriority;
  due_on: string | null;
  requested_lifetime_minutes: number;
}

export type TodoInputRefusal =
  | 'title_required' | 'text_too_long' | 'too_many_items' | 'invalid_priority' | 'invalid_due_on';

export class InvalidTodoInput extends Error {
  constructor(readonly code: TodoInputRefusal) {
    super(code);
    this.name = 'InvalidTodoInput';
  }
}

const dueOn = new RegExp(DUE_ON_PATTERN);

/**
 * One reading of a ToDo body, shared by the screen and the external API.
 *
 * It is lenient about shape and strict about meaning. A list may arrive as an array
 * or as lines of text, because a person typing into a box writes lines and a program
 * sends an array, and both mean the same list; blank lines are dropped. A missing
 * field is the empty value. What is refused is what would make the record unusable:
 * no title, a due date that is not a day, a priority that is not one of the three, or
 * text long enough that it was never meant for a ToDo. The lifetime keeps its own
 * refusal code because its bounds are the platform's, not this form's.
 *
 * Nothing here reads `status`, `agent_id` or `source`: those are the app's to write.
 */
export function readTodoInput(body: Record<string, unknown>, defaults: { lifetimeMinutes: number }): TodoInput {
  const title = text(body.title, TODO_TITLE_MAX).trim();
  if (title === '') throw new InvalidTodoInput('title_required');

  const priority = body.priority === undefined || body.priority === null || body.priority === '' ? 'normal' : body.priority;
  if (!(TODO_PRIORITY_VALUES as readonly unknown[]).includes(priority)) throw new InvalidTodoInput('invalid_priority');

  return {
    title,
    description: text(body.description, TODO_TEXT_MAX).trim(),
    context: text(body.context, TODO_CONTEXT_MAX).trim(),
    done_criteria: lines(body.done_criteria),
    steps: lines(body.steps),
    notes: lines(body.notes),
    priority: priority as TodoPriority,
    due_on: day(body.due_on),
    requested_lifetime_minutes: validateLifetimeMinutes(body.requested_lifetime_minutes ?? defaults.lifetimeMinutes),
  };
}

function text(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  const string = typeof value === 'string' ? value : String(value);
  if (string.length > max) throw new InvalidTodoInput('text_too_long');
  return string;
}

/** One item per line, or one item per array element: a person writes a list, not JSON. */
function lines(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item : String(item ?? '')))
    : typeof value === 'string' ? value.split('\n') : [];
  const kept = items.map((item) => item.trim()).filter((item) => item !== '');
  if (kept.length > TODO_LIST_MAX_ITEMS) throw new InvalidTodoInput('too_many_items');
  if (kept.some((item) => item.length > TODO_LIST_ITEM_MAX)) throw new InvalidTodoInput('text_too_long');
  return kept;
}

/** A calendar day or nothing. `2026-02-30` is a day that does not exist, and is refused. */
function day(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !dueOn.test(value)) throw new InvalidTodoInput('invalid_due_on');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new InvalidTodoInput('invalid_due_on');
  return value;
}
