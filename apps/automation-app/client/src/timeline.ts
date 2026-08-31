import { playReplay } from './replay.js';
import { wireDetailToggles } from './detail-toggle.js';

/**
 * The timeline page's browser half.
 *
 * It fetches on load and when the refresh button is pressed, and at no other time.
 * There is no `setInterval`, no `EventSource` and no WebSocket: a timeline that
 * streamed would need a live channel to Firestore, and the browser is deliberately
 * never given one (DEV-13).
 */
export function start(root: Document = document): void {
  const load = async (): Promise<void> => {
    const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json() as { tasks: Array<{ task_id: string; events?: unknown[] }> };
    for (const task of body.tasks) {
      const canvas = root.querySelector<HTMLElement>(`.replay[data-task-id="${task.task_id}"]`);
      if (canvas && Array.isArray(task.events)) {
        canvas.addEventListener('click', () => playReplay(canvas, task.events as never));
      }
    }
    wireDetailToggles(root);
  };

  void load();
  root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => { void load(); });
}

if (typeof document !== 'undefined') start();
