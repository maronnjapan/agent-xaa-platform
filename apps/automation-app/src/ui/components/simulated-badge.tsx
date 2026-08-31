import type { Element } from '../element.js';

export const SIMULATED_LABEL = 'デモ実行（模擬）';

/**
 * RULE-58. A scripted event must never be mistakable for something that happened.
 *
 * The badge is always in the open — never inside a `<details>` — because the whole
 * risk is a person seeing a dramatic screen and believing it. It appears in three
 * places for the same reason: the list row, the replay canvas and the detail summary
 * are the three ways someone can end up looking at a simulated task.
 */
export function SimulatedBadge(props: { position: 'row' | 'canvas' | 'summary' }): Element {
  return (
    <span class={`simulated-badge simulated-${props.position}`} data-simulated="true">
      {SIMULATED_LABEL}
    </span>
  );
}
