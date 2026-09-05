import { playReplay, showLocalTimes, type ReplayController } from './replay.js';
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
 *
 * Tasks are found by `run_id` and `task_id` together: two agents each have a `task-1`,
 * and wiring by the id alone attached both replays to whichever came first.
 */
export function start(root: Document = document): void {
  const controllers = new Map<string, ReplayController>();
  const wired = new Set<string>();

  const load = async (): Promise<void> => {
    const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = await response.json() as { tasks: Array<{ run_id: string; task_id: string; events?: unknown[] }> };
    for (const task of body.tasks) {
      const key = `${task.run_id}:${task.task_id}`;
      if (!Array.isArray(task.events) || wired.has(key)) continue;
      const canvas = root.querySelector<HTMLElement>(`[data-replay-key="${key}"]`);
      if (!canvas) continue;
      wired.add(key);
      const log = root.querySelector(`[data-log-key="${key}"]`);
      const events = task.events as ReplayEvent[];
      const begin = (autoplay: boolean): ReplayController => {
        const controller = playReplay(canvas, events, { log, autoplay });
        controllers.set(key, controller);
        return controller;
      };
      // A click anywhere on the canvas still starts it, which is how the page worked
      // before the buttons existed and is what a person tries first.
      canvas.addEventListener('click', (event: Event) => {
        if (isControl(event.target)) return;
        begin(true);
      });
      wireControls(canvas, key, controllers, begin);
      wireRow(root, key, canvas, controllers, begin);
    }
    wireDetailToggles(root);
    showLocalTimes(root);
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
  key: string,
  controllers: Map<string, ReplayController>,
  begin: (autoplay: boolean) => ReplayController,
): void {
  const on = (action: string, run: (controller: ReplayController | undefined) => void): void => {
    canvas.querySelector(`[data-action="${action}"]`)?.addEventListener('click', () => {
      run(controllers.get(key));
    });
  };
  // `begin` already starts moving, so the first press starts it and later presses
  // resume it. Calling `play()` on a freshly begun replay would draw two steps at once.
  on('replay-play', (controller) => { if (controller) controller.play(); else begin(true); });
  on('replay-pause', (controller) => { controller?.pause(); });
  on('replay-step', (controller) => { if (controller) controller.next(); else begin(false).next(); });
  on('replay-restart', (controller) => { if (controller) controller.restart(); else begin(true); });
}

/**
 * The row in the list is the way docs 11 §5.1 says a replay is chosen: pressing it
 * brings its picture into view and starts it, or restarts one that already finished.
 */
function wireRow(
  root: Document,
  key: string,
  canvas: HTMLElement,
  controllers: Map<string, ReplayController>,
  begin: (autoplay: boolean) => ReplayController,
): void {
  root.querySelectorAll<HTMLElement>(`[data-task-key="${key}"]`).forEach((row) => {
    if (row.hasAttribute('disabled')) return;
    row.addEventListener('click', () => {
      canvas.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      const controller = controllers.get(key);
      if (!controller) { begin(true); return; }
      if (canvas.getAttribute('data-replay-state') === 'finished') controller.restart();
      else controller.play();
    });
  });
}

if (typeof document !== 'undefined') start();
