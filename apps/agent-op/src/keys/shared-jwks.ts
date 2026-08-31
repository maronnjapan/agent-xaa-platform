import { XaaCryptoError } from '@xaa/crypto';

export interface JwkSet { keys: Array<JsonWebKey & { kid?: string }> }

export interface JwksSource {
  /** Reads the aggregated jwks.json object from the shared bucket. */
  read(): Promise<JwkSet>;
}

const TTL_MS = 300_000;
const MIN_REFETCH_MS = 1_000;

/**
 * REQ-05-025. subject_token is verified against the JWK Set Human IdP and Agent OP
 * share, not against a key of this service.
 *
 * A failed fetch throws rather than serving a stale cache: continuing to accept
 * signatures from a key set that may already have been rotated out is worse than a
 * short outage.
 */
export function createSharedJwks(source: JwksSource, now: () => number = () => Date.now()) {
  let cached: JwkSet | undefined;
  let fetchedAt = 0;
  let lastRefetchAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<JwkSet> | undefined;

  const fetchOnce = async (): Promise<JwkSet> => {
    // Concurrent callers share one GET; a burst of unknown kids must not fan out.
    inFlight ??= source.read().then((value) => {
      cached = value;
      fetchedAt = now();
      return value;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };

  const load = async (): Promise<JwkSet> => {
    if (cached && now() - fetchedAt < TTL_MS) return cached;
    return fetchOnce();
  };

  return {
    async loadSharedJwks(): Promise<JwkSet> { return load(); },

    async resolveKeyByKid(kid: string): Promise<JsonWebKey | null> {
      let set = await load();
      let found = set.keys.find((key) => key.kid === kid);
      if (!found && now() - lastRefetchAt >= MIN_REFETCH_MS) {
        lastRefetchAt = now();
        set = await fetchOnce();
        found = set.keys.find((key) => key.kid === kid);
      }
      return found ?? null;
    },

    /**
     * DEC-ID-20. Only Human IdP's SSO keys may verify a subject_token; handing over
     * the full set would let a JWT signed by this OP's own key be accepted as one.
     */
    async subjectTokenJwks(): Promise<JwkSet> {
      const set = await load();
      return { keys: set.keys.filter((key) => typeof key.kid === 'string' && key.kid.startsWith('idp-')) };
    },
  };
}

export function assertJwkSet(value: unknown): asserts value is JwkSet {
  if (!value || typeof value !== 'object' || !Array.isArray((value as JwkSet).keys)) {
    throw new XaaCryptoError('invalid_jwk');
  }
}
