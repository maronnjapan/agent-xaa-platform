/**
 * Where the browser is sent, in the two ways this app ever sends it.
 *
 * Both are guarded so they are no-ops on the server: the components that call them
 * render in both places, and a handler that reached for `window` while the page was
 * being rendered into HTML would take the whole render down.
 *
 * Reloading rather than patching the screen is deliberate. The state of a piece of work
 * lives on the server — the draft, its confirmation, the permissions that were
 * presented and whether they were approved — so re-reading it from there is what keeps
 * the screen from claiming a step happened that did not.
 */
export function reloadPage(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

export function navigateTo(url: string): void {
  if (typeof window !== 'undefined') window.location.assign(url);
}
