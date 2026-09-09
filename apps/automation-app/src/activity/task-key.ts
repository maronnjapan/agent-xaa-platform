/**
 * The one string the page and the browser both build to find a task.
 *
 * It lives apart from `query.ts` because the screens need it and `query.ts` reaches the
 * datastore: importing the key from there pulled the Firestore client into the browser
 * bundle, which is the one thing the frontend must never contain (DEV-13). A pair of
 * ids joined by a colon needs nothing from a database.
 *
 * Two agents each have a `task-1`, so the pair (`run_id`, `task_id`) is what names a
 * task uniquely, and the page keys its canvases and logs by that pair rather than by
 * `task_id` alone.
 */
export function taskKeyOf(task: { run_id: string; task_id: string }): string {
  return `${task.run_id}:${task.task_id}`;
}
