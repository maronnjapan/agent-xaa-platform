import {
  TODO_CONTEXT_MAX, TODO_TEXT_MAX, TODO_TITLE_MAX,
} from '@xaa/automation-app/src/schemas/index';
import type { TodoInput } from '@xaa/automation-app/src/work-definition/input';
import type { ReviewPriority, ReviewTask } from './tasks.js';

/**
 * A reviewer's task, written as the ToDo body `POST /external/todos` reads.
 *
 * The mapping lives here rather than in the review tool because it is a statement about
 * this platform's ToDo: which of its fields a review task can honestly fill, and which
 * it must leave alone. `done_criteria`, `steps` and `notes` are left empty on purpose —
 * a review task does not carry them, and inventing them would put words in front of an
 * agent that no person wrote.
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

/** The review tool orders work by when to start it; this app by how much it matters. */
export const PRIORITY_FROM_REVIEW: Record<ReviewPriority, TodoInput['priority']> = {
  now: 'high',
  next: 'normal',
  later: 'low',
};

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
    done_criteria: [],
    steps: [],
    notes: [],
    priority: PRIORITY_FROM_REVIEW[task.priority],
    ...(task.due === '' ? {} : { due_on: task.due }),
  };
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
