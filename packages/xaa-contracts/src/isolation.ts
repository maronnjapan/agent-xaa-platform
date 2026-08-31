export const ISOLATION_LEVELS = ['standard', 'full_isolation'] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export function assertIsolationLevel(value: unknown): asserts value is IsolationLevel {
  if (typeof value !== 'string' || !ISOLATION_LEVELS.some((candidate) => candidate === value)) throw new Error('invalid isolation level');
}

export function maxIsolationLevel(a: IsolationLevel, b: IsolationLevel): IsolationLevel {
  return a === 'full_isolation' || b === 'full_isolation' ? 'full_isolation' : 'standard';
}
