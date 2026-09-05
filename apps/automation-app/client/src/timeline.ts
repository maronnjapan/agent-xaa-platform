import { playReplay, type ReplayController } from './replay.js';
import type { ReplayEvent } from './replay-plan.js';
import { wireDetailToggles } from './detail-toggle.js';

/**
 * The timeline page's browser half.
 *
 * It fetches on load and when the refresh button is pressed, and at no other time.
 * There is no `setInterval`, no `EventSource` and no WebSocket: a timeline that
 * streamed would need a live channel to Firestore, and the browser is deliberately
 * never given one (DEV-13).
 *
 * What it does with the answer is wire four buttons and a click, once per task. The
 * words are already on the page — the server rendered every event and every record
 * from what their publishers wrote — so nothing here builds a sentence; it starts,
 * pauses and steps the picture, and marks which written entry the picture is on.
 */
export function start(root: Document = document): void {
  const controllers = new Map<string, ReplayController>();
  const wired = new Set<string>();

  const load = async (): Promise<void> => {
    const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json() as { tasks: Array<{ task_id: string; events?: unknown[] }> };
    for (const task of body.tasks) {
      if (!Array.isArray(task.events) || wired.has(task.task_id)) continue;
      const canvas = root.querySelector<HTMLElement>(`.replay[data-task-id="${task.task_id}"]`);
      if (!canvas) continue;
      wired.add(task.task_id);
      const log = root.querySelector(`[data-event-log="${task.task_id}"]`);
      const events = task.events as ReplayEvent[];
      const begin = (autoplay: boolean): ReplayController => {
        const controller = playReplay(canvas, events, { log, autoplay });
        controllers.set(task.task_id, controller);
        return controller;
      };
      // A click anywhere on the canvas still starts it, which is how the page worked
      // before the buttons existed and is what a person tries first.
      canvas.addEventListener('click', (event: Event) => {
        if (isControl(event.target)) return;
        begin(true);
      });
      wireControls(canvas, task.task_id, controllers, begin);
    }
    wireDetailToggles(root);
  };

  void load();
  root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => { void load(); });
}

/** A press on a button is that button's job, not "start the replay from the top". */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-replay-controls]') !== null;
}

/**
 * The four buttons, and what each of them means before anything has started.
 *
 * "再生" and "最初から" begin a replay that is not running; "次へ" begins one without
 * moving, so the first press shows the first step rather than the second; "一時停止"
 * does nothing at all, because there is nothing to pause and starting a replay in
 * order to stop it is not what the word says.
 */
function wireControls(
  canvas: HTMLElement,
  taskId: string,
  controllers: Map<string, ReplayController>,
  begin: (autoplay: boolean) => ReplayController,
): void {
  const on = (action: string, run: (controller: ReplayController | undefined) => void): void => {
    canvas.querySelector(`[data-action="${action}"]`)?.addEventListener('click', () => {
      run(controllers.get(taskId));
    });
  };
  // `begin` already starts moving, so the first press starts it and later presses
  // resume it. Calling `play()` on a freshly begun replay would draw two steps at once.
  on('replay-play', (controller) => { if (controller) controller.play(); else begin(true); });
  on('replay-pause', (controller) => { controller?.pause(); });
  on('replay-step', (controller) => { if (controller) controller.next(); else begin(false).next(); });
  on('replay-restart', (controller) => { if (controller) controller.restart(); else begin(true); });
}

if (typeof document !== 'undefined') start();
