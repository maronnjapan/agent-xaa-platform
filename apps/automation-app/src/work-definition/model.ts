import { compile } from '@xaa/contracts';
import { workDefinitionSchema, WORK_DEFINITION_FIELDS, TODO_PRIORITY_VALUES, TODO_STATUS_VALUES } from '../schemas/index.js';

export type WorkDefinitionStatus = (typeof TODO_STATUS_VALUES)[number];
export type TodoPriority = (typeof TODO_PRIORITY_VALUES)[number];
export type TodoSource = 'screen' | 'api';

/**
 * One ToDo, which is the platform's Work Definition with the fields an AI needs to
 * carry it out unattended.
 *
 * `title`, `description` and `context` are what the agent reads first; `done_criteria`
 * is how it knows when to stop; `steps` and `notes` are the person's hints and limits.
 * `priority` and `due_on` order the list and travel to the agent as words. None of
 * these names a permission: what the work needs is decided elsewhere (RULE-07).
 */
export interface WorkDefinition {
  work_definition_id: string;
  human_subject: string;
  status: WorkDefinitionStatus;
  title: string;
  description: string;
  context: string;
  done_criteria: string[];
  steps: string[];
  notes: string[];
  priority: TodoPriority;
  due_on: string | null;
  requested_lifetime_minutes: number;
  source: TodoSource;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export { WORK_DEFINITION_FIELDS };

export const assertWorkDefinition: (value: unknown) => asserts value is WorkDefinition =
  compile<WorkDefinition>(workDefinitionSchema);

/** Refused because the ToDo is no longer a draft: its wording is settled. */
export class TodoNotDraft extends Error { readonly code = 'todo_not_draft'; }
/** Refused because the ToDo is already done or withdrawn. */
export class TodoClosed extends Error { readonly code = 'todo_closed'; }

const OPEN: ReadonlySet<WorkDefinitionStatus> = new Set(['DRAFT', 'CONFIRMED', 'IN_PROGRESS']);

/** Still on the list: not yet done, not withdrawn. */
export function isOpen(definition: Pick<WorkDefinition, 'status'>): boolean {
  return OPEN.has(definition.status);
}

/**
 * Five states, and only a person moves between the ones that matter.
 *
 * RULE-08: the Automation Design AI proposes, it does not conclude. There is no
 * `CONFIRMING`, no timer that promotes a draft and no branch that reads a model's
 * "I have confirmed this" as confirmation — the transition happens in exactly one
 * route handler, called by a click. The same holds for `DONE` and `CANCELLED`: an
 * agent finishing its task is shown on the card, and the person decides what that
 * means for the ToDo.
 */
export function confirm(definition: WorkDefinition, now: string): WorkDefinition {
  if (definition.status !== 'DRAFT') throw new TodoNotDraft();
  return { ...definition, status: 'CONFIRMED', updated_at: now };
}

/** The agent that now carries this ToDo, recorded the moment provisioning names it. */
export function startExecution(definition: WorkDefinition, agentId: string, now: string): WorkDefinition {
  if (!isOpen(definition)) throw new TodoClosed();
  return { ...definition, status: 'IN_PROGRESS', agent_id: agentId, updated_at: now };
}

export function complete(definition: WorkDefinition, now: string): WorkDefinition {
  if (!isOpen(definition)) throw new TodoClosed();
  return { ...definition, status: 'DONE', updated_at: now, completed_at: now };
}

export function cancel(definition: WorkDefinition, now: string): WorkDefinition {
  if (!isOpen(definition)) throw new TodoClosed();
  return { ...definition, status: 'CANCELLED', updated_at: now, completed_at: now };
}

const PRIORITY_RANK: Readonly<Record<TodoPriority, number>> = { high: 0, normal: 1, low: 2 };

/**
 * The order a list is read in: open items first, the urgent ones at the top.
 *
 * Among open ToDos, priority wins, then the nearer due date, then the newer one. Closed
 * ToDos follow, most recently closed first, so the list a person scans is the work that
 * is still theirs and the archive sits below it.
 */
export function compareTodos(left: WorkDefinition, right: WorkDefinition): number {
  const leftOpen = isOpen(left);
  if (leftOpen !== isOpen(right)) return leftOpen ? -1 : 1;
  if (!leftOpen) return (right.completed_at ?? '').localeCompare(left.completed_at ?? '');
  const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (byPriority !== 0) return byPriority;
  if (left.due_on !== right.due_on) {
    if (left.due_on === null) return 1;
    if (right.due_on === null) return -1;
    return left.due_on.localeCompare(right.due_on);
  }
  return right.created_at.localeCompare(left.created_at);
}
