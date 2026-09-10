/**
 * Where the activity screens are, written down once.
 *
 * The screen has two faces. `/activity` is the list: one card per agent, one line per
 * task, and nothing that moves. Adding `run` to the address opens one agent in the
 * viewer, which shows one thing at a time — the picture of the story, or the account
 * of one task — and `task`, `view` and `event` say which thing. The server renders
 * whichever face the address names, so a person without script still reads the
 * account of a task by following a link, and a person with script gets the same page
 * with the buttons attached (DEC-APP-06).
 *
 * The addresses are built here and nowhere else, so the list, the viewer and the
 * agent's own screen cannot each spell them differently.
 */

/** Which of the viewer's two faces is showing: the moving picture, or the written account. */
export type ActivityView = 'replay' | 'log';

export interface ActivityFocus {
  /** The agent the viewer is on: the `run_id` its tasks share. */
  runId: string;
  /** The task to stand on, or null for the start of the whole story. */
  taskId: string | null;
  view: ActivityView;
  /** The event to stand on within the task, or null for the task's first. */
  eventId: string | null;
}

/** The query keys the address carries. The list's narrowing key is the one it always had. */
export const AGENT_KEY = 'agent_id';
export const RUN_KEY = 'run';
export const TASK_KEY = 'task';
export const VIEW_KEY = 'view';
export const EVENT_KEY = 'event';

export const ACTIVITY_PATH = '/activity';

/** `replay` unless the address plainly asks for the account; an unknown word is the picture. */
export function activityViewOf(value: string | null | undefined): ActivityView {
  return value === 'log' ? 'log' : 'replay';
}

/** The list, narrowed to one agent when it was. */
export function activityListPath(agentId: string | null): string {
  return agentId === null ? ACTIVITY_PATH : `${ACTIVITY_PATH}?${AGENT_KEY}=${encodeURIComponent(agentId)}`;
}

/**
 * The viewer, on one agent, one task, one face and one event.
 *
 * The narrowing key travels along, so closing the viewer returns a person to the list
 * they came from rather than to everything.
 */
export function activityFocusPath(focus: ActivityFocus, agentId: string | null = null): string {
  const query = new URLSearchParams();
  if (agentId !== null) query.set(AGENT_KEY, agentId);
  query.set(RUN_KEY, focus.runId);
  if (focus.taskId !== null) query.set(TASK_KEY, focus.taskId);
  query.set(VIEW_KEY, focus.view);
  if (focus.eventId !== null) query.set(EVENT_KEY, focus.eventId);
  return `${ACTIVITY_PATH}?${query.toString()}`;
}
