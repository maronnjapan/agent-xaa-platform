export const DPOP_JTI_TTL_SECONDS = 120;
export const ACTOR_TOKEN_JTI_TTL_SECONDS = 360;
export const CLIENT_ASSERTION_JTI_TTL_SECONDS = 360;

export type JtiNamespace = 'dpop' | 'actor-token' | 'client-assertion';

export interface JtiStore {
  consume(namespace: JtiNamespace, jti: string, ttlSeconds: number): Promise<boolean>;
}

/** Process-local implementation for unit and single-process integration tests only. */
export class InMemoryJtiStore implements JtiStore {
  readonly #entries = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async consume(namespace: JtiNamespace, jti: string, ttlSeconds: number): Promise<boolean> {
    const current = this.now();
    for (const [key, expiresAt] of this.#entries) if (expiresAt <= current) this.#entries.delete(key);
    const key = `${namespace}:${jti}`;
    if (this.#entries.has(key)) return false;
    this.#entries.set(key, current + ttlSeconds * 1000);
    return true;
  }
}
