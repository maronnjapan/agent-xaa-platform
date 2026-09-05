/**
 * How long one step moves for, and how long it stays before the next one starts.
 *
 * Two numbers, both between one and two seconds. The replay used to run one step every
 * 800ms with the motion filling the whole of it, which meant the dot landed and the
 * next step wiped it in the same instant: a person reading the caption that named the
 * step was still on the previous sentence. The motion now takes 1.2s and the finished
 * frame is left standing for the remaining 0.6s, so every step is something to read
 * rather than something that goes past.
 *
 * Longer than this would turn a tool call's eight exchanges into a quarter of a minute
 * of sitting still, which is what 「一時停止」 and 「次へ」 are for instead.
 */
export const REPLAY_MOTION_MS = 1200;
export const REPLAY_STEP_MS = 1800;

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
