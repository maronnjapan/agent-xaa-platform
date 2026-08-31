export const MIN_LIFETIME_HOURS = 1;
export const MAX_LIFETIME_HOURS = 24;

export class LifetimeOutOfRange extends Error {
  readonly code = 'lifetime_out_of_range';
}

/**
 * One to twenty-four whole hours.
 *
 * The upper bound is not configurable. It is the same 24 hours that
 * `agent_max_lifetime_seconds` caps the Job at, and a screen that could ask for more
 * would produce agents the platform then silently truncates — a promise the system
 * does not keep. Nothing rounds: `1.5` is a request the caller should restate, not one
 * to guess at.
 */
export function validateLifetimeHours(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new LifetimeOutOfRange();
  if (value < MIN_LIFETIME_HOURS || value > MAX_LIFETIME_HOURS) throw new LifetimeOutOfRange();
  return value;
}
