import type { AccessTokenBinding, ResourceAccessToken } from '../http/resource-authorization.js';

/**
 * Every credential an Execution holds, and nowhere else it can go.
 *
 * REQ-05-090: an agent's tokens live for the length of one Job Execution. The store
 * is a Map with three methods; there is no `save`, no `persist`, no `toJSON`, and no
 * constructor taking a backend. The absence is the design — a future contributor
 * cannot add persistence here without changing the type that everything else uses.
 *
 * Being the only home is also what lets a tool call skip the Agent OP: a token this
 * Execution already holds is read back from here rather than asked for again. That
 * changes nothing about how long a credential lives — the Map dies with the process,
 * and Cleanup's step1 ends the process (docs 07 §6).
 */
export type TokenKey = `subject` | `idjag:${string}` | `at:${string}`;

const KEY_SHAPE = /^(subject|idjag:[^\s|]+|at:[^\s|]+\|[^\s|]*\|[^\s|]*)$/;

/** Read a token back only while it has this much life left. */
export const TOKEN_SKEW_MS = 30_000;

/**
 * What an `at:` key holds.
 *
 * An Access Token is not only a string: the redemption that produced it also settled
 * how it must be presented, and a call reusing the token has to present it the same
 * way. The two are stored together so they cannot come apart — and because the value
 * is the branded type, only `redeem-id-jag` and `redeem-via-bridge` can fill one of
 * these keys. A string that merely looks like an Access Token has no way in.
 */
export interface HeldAccessToken {
  readonly accessToken: ResourceAccessToken;
  readonly binding: AccessTokenBinding;
}

/** A held Access Token, and the moment it stops being usable. */
export interface LiveAccessToken extends HeldAccessToken {
  readonly expiresAt: number;
}

export class TokenStore {
  readonly #entries = new Map<string, { value: string | HeldAccessToken; expiresAt: number }>();

  /**
   * An `at:` key answers with the whole redemption, the other two with the token.
   *
   * One lookup with one skew, told to the caller in the terms it has to act on: a
   * subject token or an ID-JAG is handed on as it is, while an Access Token is of no
   * use without knowing how to present it and until when.
   */
  get(key: `at:${string}`, now?: number): LiveAccessToken | undefined;
  get(key: `subject` | `idjag:${string}`, now?: number): string | undefined;
  get(key: TokenKey, now: number = Date.now()): LiveAccessToken | string | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt - TOKEN_SKEW_MS <= now) return undefined;
    return typeof entry.value === 'string' ? entry.value : { ...entry.value, expiresAt: entry.expiresAt };
  }

  set(key: `at:${string}`, value: HeldAccessToken, expiresAt: number): void;
  set(key: `subject` | `idjag:${string}`, value: string, expiresAt: number): void;
  set(key: TokenKey, value: string | HeldAccessToken, expiresAt: number): void {
    if (!KEY_SHAPE.test(key)) throw new Error(`invalid token key: ${key}`);
    this.#entries.set(key, { value, expiresAt });
  }

  clear(): void {
    this.#entries.clear();
  }
}

export function accessTokenKey(authorization: { audience: string; resource: string; scope: string }): `at:${string}` {
  return `at:${authorization.audience}|${authorization.resource}|${authorization.scope}`;
}

export function idJagKey(toolId: string): `idjag:${string}` {
  return `idjag:${toolId}`;
}
