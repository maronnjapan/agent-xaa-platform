/** Refresh only the read-only panel, preserving forms, focus and opened details. */
export function startMonitor(root: Document, url: string, selector: string): void {
  let busy = false;
  const refresh = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    const status = root.querySelector('[data-monitor-status]');
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(String(response.status));
      const fragment = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector(selector);
      const current = root.querySelector(selector);
      let deferred = false;
      if (fragment && current) {
        // Leave a panel being read or keyboard-operated in place until focus leaves.
        deferred = Boolean(current.querySelector('details[open]')) || current.contains(root.activeElement);
        if (!deferred) current.replaceWith(fragment);
      }
      if (status) status.textContent = `取得時刻 ${new Date().toLocaleTimeString('ja-JP')} · ${deferred ? '詳細を閲覧中のため表示更新を保留しています' : '表示を更新しました'}`;
    } catch {
      if (status) status.textContent = '更新できませんでした。表示は前回の取得結果です。';
    } finally { busy = false; }
  };
  root.querySelector('[data-action="monitor-refresh"]')?.addEventListener('click', () => { void refresh(); });
  const poll = (): void => {
    setTimeout(() => {
      if (root.visibilityState !== 'hidden' && root.querySelector<HTMLInputElement>('[data-monitor-auto]')?.checked) void refresh();
      poll();
    }, 5000);
  };
  poll();
}
