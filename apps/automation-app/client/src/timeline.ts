import { playReplay } from './replay.js';
import { wireDetailToggles } from './detail-toggle.js';
import type { ReplayEvent } from './replay-plan.js';

export function start(root: Document = document): void {
  let tasks: Array<{ task_id: string; agent_id: string | null; events?: ReplayEvent[] }> = [];
  let cancel: (() => void) | undefined;
  const status = root.querySelector('[data-timeline-status]');
  const inspectors = Array.from(root.querySelectorAll<HTMLElement>('[data-inspector-task]'));
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-task-button]'));
  const play = (panel: HTMLElement): void => {
    const task = tasks.find((item) => item.task_id === panel.getAttribute('data-inspector-task')
      && (item.agent_id ?? '') === panel.getAttribute('data-agent-id'));
    const canvas = panel.querySelector<HTMLElement>('.replay');
    if (!task?.events || !canvas) {
      if (status) status.textContent = '再生データを取得できていません。更新して再度お試しください。';
      return;
    }
    cancel?.();
    canvas.querySelector('[data-arrows]')?.replaceChildren();
    canvas.querySelector('[data-messages]')?.replaceChildren();
    const banner = canvas.querySelector('[data-banner]');
    if (banner) banner.textContent = '';
    cancel = playReplay(canvas, task.events);
  };
  for (const button of buttons) button.addEventListener('click', () => {
    cancel?.();
    for (const panel of inspectors) {
      const selected = panel.getAttribute('data-inspector-task') === button.getAttribute('data-task-id')
        && panel.getAttribute('data-agent-id') === button.getAttribute('data-agent-id');
      panel.hidden = !selected;
      if (selected) { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    for (const item of buttons) item.setAttribute('aria-expanded', String(item === button));
  });
  for (const panel of inspectors) panel.querySelector('[data-action="play-replay"]')?.addEventListener('click', () => play(panel));
  wireDetailToggles(root);
  void (async () => {
    try {
      const response = await fetch('/api/activity/tasks', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { tasks: typeof tasks };
      tasks = body.tasks;
    } catch { if (status) status.textContent = '再生データの取得に失敗しました。更新して再度お試しください。'; }
  })();
  // Reload the server-rendered rows too, preserving the current agent filter in the URL.
  root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => root.location.reload());
  root.querySelector<HTMLSelectElement>('[data-filter="outcome"]')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    let shown = 0;
    for (const button of buttons) {
      const match = value === 'all' || button.getAttribute('data-status') === value
        || button.getAttribute('data-outcome') === value;
      const row = button.closest<HTMLElement>('.task-row');
      if (row) row.hidden = !match;
      if (match) shown += 1;
    }
    for (const group of Array.from(root.querySelectorAll<HTMLElement>('.agent-group'))) {
      group.hidden = !group.querySelector('.task-row:not([hidden])');
    }
    for (const panel of inspectors) panel.hidden = true;
    for (const button of buttons) button.setAttribute('aria-expanded', 'false');
    cancel?.();
    if (status) status.textContent = `${shown} 件を表示`;
  });
}
if (typeof document !== 'undefined') start();
