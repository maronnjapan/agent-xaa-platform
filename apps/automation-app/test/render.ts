import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The two ways a React screen is looked at from a test.
 *
 * `html` is the markup the server serves — what a person is handed before any script
 * runs, and what most assertions here are about. `mount` is the same components running
 * in a document, for the handful of behaviours that only exist once someone has pressed
 * something: the replay's steps, the stop button, a refusal shown in place.
 *
 * A spec that calls `mount` says `@vitest-environment happy-dom` at the top of the
 * file. The rest run with no DOM at all, which is what keeps the suite fast and what
 * makes the distinction visible: a test that needs a document is testing behaviour, and
 * one that does not is testing what was rendered.
 */
export function html(element: unknown): string {
  return renderToStaticMarkup(element as ReactElement);
}

export interface Mounted {
  container: HTMLElement;
  /** Runs an interaction and lets React finish with it before returning. */
  act(work: () => void | Promise<void>): Promise<void>;
  find(selector: string): HTMLElement | null;
  /** Presses something, whether it is a button or a box on the diagram. */
  click(selector: string): Promise<void>;
  all(selector: string): HTMLElement[];
  text(selector: string): string;
  unmount(): Promise<void>;
}

/**
 * The components in a document, rendered the way the browser renders them.
 *
 * `createRoot` rather than `hydrateRoot`: what a mounted test asks about is behaviour
 * after an interaction, and starting from the same tree the server would have produced
 * is enough for that. Whether the server's markup and the browser's first render agree
 * is a different question, and `html` is where it is asked.
 */
export async function mount(element: ReactElement): Promise<Mounted> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ignoreCancelledAnimations();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    act: async (work) => { await act(async () => { await work(); }); },
    find: (selector) => container.querySelector<HTMLElement>(selector),
    // Dispatched rather than called: `click()` belongs to HTMLElement, and half the
    // things a person presses on this screen are SVG.
    click: async (selector) => {
      const target = container.querySelector(selector);
      if (!target) throw new Error(`nothing to press at ${selector}`);
      await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    },
    all: (selector) => [...container.querySelectorAll<HTMLElement>(selector)],
    text: (selector) => container.querySelector(selector)?.textContent ?? '',
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/**
 * Cancelling a running animation is not an error, and in a browser it is not reported
 * as one: `Animation.finished` rejects with an `AbortError` that the animation library
 * has already handled. The DOM double used here rejects a second, unheld promise for
 * the same event, which arrives as an unhandled rejection and fails whichever test
 * happens to be running when a component unmounts.
 *
 * Only that one rejection is swallowed, and only once per process. Anything else still
 * fails the run.
 */
let guarded = false;
function ignoreCancelledAnimations(): void {
  if (guarded) return;
  guarded = true;
  process.on('unhandledRejection', (reason) => {
    if (reason instanceof Error && reason.name === 'AbortError') return;
    throw reason;
  });
}
