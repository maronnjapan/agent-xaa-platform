/** One step is one step, however long the real gap was. */
export const REPLAY_STEP_MS = 800;

/**
 * How far along the arrow a blocked step stops.
 *
 * Sixty per cent: far enough to read as "it set off", short enough that the gap to the
 * destination is unmistakable. Defined once and used by both the animation and the CSS
 * custom property, so the picture and the assertion about it cannot drift.
 */
export const BLOCKED_STOP_RATIO = 0.6;
