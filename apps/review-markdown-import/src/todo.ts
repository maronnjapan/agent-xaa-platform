import {
  TODO_CONTEXT_MAX, TODO_LIST_ITEM_MAX, TODO_LIST_MAX_ITEMS, TODO_TEXT_MAX, TODO_TITLE_MAX,
} from '@xaa/automation-app/src/schemas/index';
import type { TodoInput } from '@xaa/automation-app/src/work-definition/input';
import type { ReviewTask } from './tasks.js';

/**
 * A reviewer's task, written as the ToDo body `POST /external/todos` reads.
 *
 * The mapping lives here rather than in the review tool because it is a statement about
 * this platform's ToDo: which of its fields a review task can honestly fill, and which
 * it must leave alone. The review tool now writes `done_criteria`, `steps` and `notes`
 * under its own names, with the same meanings and the same limits, so they are carried
 * across as written. Nothing here fills them in: a task whose reviewer wrote no done
 * criteria arrives with none, rather than with a bar this app invented.
 *
 * `requested_lifetime_minutes` is left out of the body entirely, so the app applies its
 * own default. A connector guessing how long an errand should be allowed to run is
 * guessing at a permission, which is not its to decide.
 *
 * The body is typed from the app's own `TodoInput`, so a field renamed there stops this
 * app from compiling instead of being quietly dropped at the far end.
 */
export type TodoRequest =
  & Pick<TodoInput, 'title' | 'description' | 'context' | 'done_criteria' | 'steps' | 'notes' | 'priority'>
  & { due_on?: string };

/** Why one task cannot be registered, in words the person can act on. */
export class TaskNotRegisterable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TaskNotRegisterable';
  }
}

export function buildTodoRequest(task: ReviewTask, documentPath: string): TodoRequest {
  const title = task.title.trim();
  if (title === '') throw new TaskNotRegisterable('the task has no title');
  // The app refuses over-long text with a code and a 400. Saying so here names the
  // field and the limit, and costs no round trip.
  limit(title, TODO_TITLE_MAX, 'title');
  limit(task.detail, TODO_TEXT_MAX, 'detail');
  const context = buildContext(task, documentPath);
  limit(context, TODO_CONTEXT_MAX, 'context');
  return {
    title,
    description: task.detail,
    context,
    done_criteria: listOf(task.doneCriteria, 'done_criteria'),
    steps: listOf(task.steps, 'steps'),
    notes: listOf(task.notes, 'notes'),
    // The review tool writes this app's own three values, so nothing is translated.
    priority: task.priority,
    ...(task.due === '' ? {} : { due_on: task.due }),
  };
}

/**
 * One list, checked against the app's bounds before it is sent.
 *
 * The review tool holds the same limits, so a list that fails here was hand-edited in
 * the task file. Naming the field and the limit costs no round trip and says where to fix it.
 */
function listOf(items: string[], field: string): string[] {
  if (items.length > TODO_LIST_MAX_ITEMS) {
    throw new TaskNotRegisterable(`${field} has more than ${TODO_LIST_MAX_ITEMS} items`);
  }
  for (const item of items) limit(item, TODO_LIST_ITEM_MAX, field);
  return items;
}

/**
 * What the agent should hold in mind while working: only what the reviewer wrote.
 *
 * The document it came from is named first, because a task read on its own loses the
 * thing it was about. Nothing here is generated — an empty field contributes no line.
 */
function buildContext(task: ReviewTask, documentPath: string): string {
  const parts: string[] = [];
  if (documentPath !== '') parts.push(`元の文書: ${documentPath}`);
  if (task.owner !== '') parts.push(`担当: ${task.owner}`);
  if (task.quote !== '') parts.push(`引用:\n${task.quote}`);
  if (task.knowledge !== '') parts.push(`参考知識:\n${task.knowledge}`);
  return parts.join('\n\n');
}

function limit(value: string, max: number, field: string): void {
  if (value.length > max) throw new TaskNotRegisterable(`${field} is longer than ${max} characters`);
}
