export const WINDOW_MINUTES = 10;
const WINDOW_MS = WINDOW_MINUTES * 60_000;

/**
 * Fixed ten-minute buckets, not a sliding window.
 *
 * A sliding window makes the same events fall into different groups depending on when
 * the pipeline happened to run, so a finding's identity would change between runs. Fixed
 * boundaries mean the same input always produces the same windows — which is what lets
 * a finding id be derived from the window and stay stable across retries.
 */
export function windowStart(occurredAt: string): number {
  return Math.floor(Date.parse(occurredAt) / WINDOW_MS) * WINDOW_MS;
}

export function groupByWindow<T>(
  items: readonly T[],
  keyFn: (item: T) => string,
  timeFn: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${windowStart(timeFn(item))}|${keyFn(item)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

export function parseWindowKey(key: string): { windowStart: number; windowEnd: number; subject: string } {
  const separator = key.indexOf('|');
  const start = Number(key.slice(0, separator));
  return { windowStart: start, windowEnd: start + WINDOW_MS, subject: key.slice(separator + 1) };
}
