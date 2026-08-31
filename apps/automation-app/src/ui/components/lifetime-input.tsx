import { MAX_LIFETIME_HOURS, MIN_LIFETIME_HOURS } from '../../work-definition/lifetime.js';
import type { Element } from '../element.js';


/**
 * The bounds are in the markup as well as in the validator.
 *
 * The browser stops most out-of-range values before they are sent, and the server
 * rejects the rest; neither replaces the other. The maximum is the constant, not a
 * setting — a deployment that raised it here would produce agents the Job then cuts
 * short at 24 hours anyway.
 */
export function LifetimeInput(props: { defaultHours: number }): Element {
  return (
    <label class="lifetime-input">
      希望する稼働時間（時間）
      <input
        type="number"
        name="requested_lifetime_hours"
        min={String(MIN_LIFETIME_HOURS)}
        max={String(MAX_LIFETIME_HOURS)}
        value={String(props.defaultHours)}
      />
    </label>
  );
}
