import { IdJagError } from '@maronn-openid-connect/experimental/id-jag';
import { decodeJwsUnverified } from '@xaa/crypto';

export const ACTOR_TOKEN_INVALID = 'The provided actor_token is not valid';
export const ACTOR_TOKEN_MAX_AGE_SECONDS = 300;
const JTI_TTL_SECONDS = 360;
const LEEWAY_SECONDS = 60;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * REQ-05-070. An actor_token is minted per request, so a second presentation is a
 * sign of theft rather than a retry.
 *
 * Known limitation: this store is per Cloud Run instance and is not shared across
 * them, so a replay that lands on a different instance is not caught here. The
 * client_assertion jti, which uses the Firestore-backed store, closes that gap for
 * the credential itself; this is the cheap in-process second line.
 */
export class ActorTokenReplayStore {
  readonly #seen = new Map<string, number>();
  #lastSweep = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  #sweep(current: number): void {
    if (current - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = current;
    for (const [key, expiresAt] of this.#seen) if (expiresAt <= current) this.#seen.delete(key);
  }

  /** Returns false when this jti was already used for this agent. */
  consume(agentId: string, jti: string): boolean {
    const current = this.now();
    this.#sweep(current);
    const key = `actor:${agentId}:${jti}`;
    const existing = this.#seen.get(key);
    if (existing !== undefined && existing > current) return false;
    this.#seen.set(key, current + JTI_TTL_SECONDS * 1000);
    return true;
  }

  get size(): number { return this.#seen.size; }
}

export function verifyActorTokenFreshness(actorToken: string, agentId: string, store: ActorTokenReplayStore, now: Date): void {
  const { payload } = decodeJwsUnverified(actorToken);
  const seconds = Math.floor(now.getTime() / 1000);
  const { exp, iat, jti } = payload;
  if (typeof exp !== 'number' || exp + LEEWAY_SECONDS <= seconds) throw new IdJagError('invalid_grant', ACTOR_TOKEN_INVALID);
  if (typeof iat !== 'number' || exp - iat > ACTOR_TOKEN_MAX_AGE_SECONDS) throw new IdJagError('invalid_grant', ACTOR_TOKEN_INVALID);
  if (typeof jti !== 'string' || jti === '' || !store.consume(agentId, jti)) throw new IdJagError('invalid_grant', ACTOR_TOKEN_INVALID);
}
