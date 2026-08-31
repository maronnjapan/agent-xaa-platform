import { EMPHASIS_LABELS, emphasisClass } from '../replay/emphasis.js';
import type { Element } from '../element.js';


/**
 * Colour is never the only difference: every badge carries its own words, so the four
 * kinds are still distinguishable to someone who cannot tell them apart by hue.
 */
export function OutcomeBadge(props: { outcome: string; phase: string }): Element {
  const className = emphasisClass(props.outcome, props.phase);
  return (
    <span class={`badge ${className}`} data-emphasis={className}>
      {className === 'ev-blocked-security' ? <WarningIcon /> : null}
      {EMPHASIS_LABELS[className]}
    </span>
  );
}

/** Inline rather than from an icon package: one glyph is not worth a dependency. */
function WarningIcon(): Element {
  return (
    <svg class="warning-icon" data-icon="warning" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 1 L15 14 L1 14 Z" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 6 L8 10" stroke="currentColor" stroke-width="1.5" />
      <circle cx="8" cy="12" r="0.8" fill="currentColor" />
    </svg>
  );
}
