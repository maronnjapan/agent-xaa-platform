/**
 * Every credential an Execution holds, and nowhere else it can go.
 *
 * REQ-05-090: an agent's tokens live for the length of one Job Execution. The store
 * is a Map with three methods; there is no `save`, no `persist`, no `toJSON`, and no
 * constructor taking a backend. The absence is the design — a future contributor
 * cannot add persistence here without changing the type that everything else uses.
 */
export type TokenKey = `subject` | `idjag:${string}` | `at:${string}`;

const KEY_SHAPE = /^(subject|idjag:[^\s|]+|at:[^\s|]+\|[^\s|]*\|[^\s|]*)$/;

/** Read a token back only while it has this much life left. */
export const TOKEN_SKEW_MS = 30_000;

export class TokenStore {
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();

  get(key: TokenKey, now: number = Date.now()): string | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt - TOKEN_SKEW_MS <= now) return undefined;
    return entry.value;
  }

  set(key: TokenKey, value: string, expiresAt: number): void {
    if (!KEY_SHAPE.test(key)) throw new Error(`invalid token key: ${key}`);
    this.#entries.set(key, { value, expiresAt });
  }

  clear(): void {
    this.#entries.clear();
  }
}

export function accessTokenKey(authorization: { audience: string; resource: string; scope: string }): TokenKey {
  return `at:${authorization.audience}|${authorization.resource}|${authorization.scope}`;
}

export function idJagKey(toolId: string): TokenKey {
  return `idjag:${toolId}`;
}
