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

/**
 * How close a refusal's stop mark may come to a box it is not about.
 *
 * A blocked movement is drawn as a fraction of the way to its destination, and on a
 * long path that fraction can land squarely on a box in between — a refusal decided
 * inside the Agent Runtime appearing to have been made by the Resource AS it happened
 * to fly over. The mark is pulled back until it is clear of every box but the one it
 * set off from.
 */
export const STOP_CLEARANCE = 8;

/** How far back to look, and in what increments, before giving up. */
export const MIN_STOP_RATIO = 0.15;
export const STOP_RATIO_STEP = 0.02;
