import { randomUUID } from 'node:crypto';
import { FORBIDDEN_ENV_KEYS, RUNTIME_ENV_KEYS, RUNTIME_EXIT_CODES, type RuntimeEnvKey, type RuntimeEnvOverrides } from '@xaa/contracts';

export class ForbiddenEnvKey extends Error {
  readonly code = 'forbidden_env_key';
  constructor(readonly key: string) { super(`forbidden_env_key: ${key}`); }
}

export class MissingEnvKey extends Error {
  readonly code = 'missing_env_key';
  constructor(readonly key: string) { super(`missing_env_key: ${key}`); }
}

export interface RuntimeEnv extends RuntimeEnvOverrides {
  /** Injected by Cloud Run, so not part of the override contract. */
  readonly executionId: string;
  readonly taskIndex: number;
}

/**
 * The forbidden check runs first, before anything reads a value it needs.
 *
 * REQ-05-090 is about what an Execution must never be able to see: a human's access
 * or refresh token, a session id, a client secret. A deployment that sets one is
 * broken in a way no later validation can repair, so the process refuses to start
 * rather than continuing with the value merely unread.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  for (const key of FORBIDDEN_ENV_KEYS) {
    if (source[key] !== undefined) throw new ForbiddenEnvKey(key);
  }
  const overrides = {} as Record<RuntimeEnvKey, string>;
  for (const key of RUNTIME_ENV_KEYS) {
    const value = source[key];
    if (value === undefined || value === '') throw new MissingEnvKey(key);
    overrides[key] = value;
  }
  return {
    ...overrides,
    executionId: source.CLOUD_RUN_EXECUTION ?? `local-${randomUUID()}`,
    taskIndex: Number(source.CLOUD_RUN_TASK_INDEX ?? '0'),
  };
}

export function startupExitCode(): number {
  return RUNTIME_EXIT_CODES.invalidStartup;
}
