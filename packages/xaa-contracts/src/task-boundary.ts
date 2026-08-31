/**
 * RULE-59. The timeline replays a task only once its terminal event has arrived, so
 * "which event ends which kind of task" has to be one table rather than a string
 * comparison scattered through the renderers.
 *
 * The event name lives in `detail.event_type`; it is a required key of `detail` for
 * every event that can terminate a task. Nothing infers the type from `title`.
 */
export const TASK_ID_PATTERN = /^(provisioning|lifecycle|task-[1-9][0-9]*|demo-[a-z-]+)$/;

export type TaskKind = 'provisioning' | 'task' | 'lifecycle' | 'demo';

export const TERMINAL_EVENTS = {
  provisioning: ['AGENT_PROVISIONED'],
  'task-{n}': ['TASK_COMPLETED', 'TASK_BLOCKED', 'TASK_FAILED'],
  lifecycle: ['AGENT_EXPIRED', 'AGENT_STOPPED', 'AGENT_QUARANTINED', 'AGENT_REVOKED_SECURITY'],
} as const;

const TERMINAL_BY_KIND: Record<TaskKind, readonly string[]> = {
  provisioning: TERMINAL_EVENTS.provisioning,
  task: TERMINAL_EVENTS['task-{n}'],
  lifecycle: TERMINAL_EVENTS.lifecycle,
  demo: [],
};

export function classifyTaskId(taskId: string): TaskKind | null {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  if (taskId === 'provisioning') return 'provisioning';
  if (taskId === 'lifecycle') return 'lifecycle';
  return taskId.startsWith('demo-') ? 'demo' : 'task';
}

/** A scripted demo task has no terminal event of its own; it is always complete. */
export function isTerminalEvent(taskId: string, eventType: string): boolean {
  const kind = classifyTaskId(taskId);
  if (kind === null) return false;
  if (kind === 'demo') return true;
  return TERMINAL_BY_KIND[kind].includes(eventType);
}
