import type { IdJagTrustedIdentityProvider } from '@maronn-openid-connect/experimental/id-jag';

/**
 * T-RES-05. Exactly one trusted issuer, and the key set is narrowed to the `idjag-`
 * and `op-shared-` prefixes so neither Human IdP's SSO key nor this AS's own key can
 * be used to verify an ID-JAG (00b fixes the prefix set).
 */
const ID_JAG_KID_PREFIXES = ['idjag-', 'op-shared-'];

export interface JwkSetShape { keys: Array<Record<string, unknown> & { kid?: string }> }

export function filterIdJagKeys(jwks: JwkSetShape): JwkSetShape {
  return { keys: jwks.keys.filter((key) => typeof key.kid === 'string' && ID_JAG_KID_PREFIXES.some((prefix) => key.kid!.startsWith(prefix))) };
}

export interface TrustedIdpOptions {
  issuer: string;
  jwksUri: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const CACHE_TTL_MS = 300_000;

/** The JWK Set is fetched from the configured URI and cached for 300 seconds. */
export function createTrustedIdpResolver(options: TrustedIdpOptions): () => Promise<IdJagTrustedIdentityProvider[]> {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const now = options.now ?? (() => Date.now());
  let cached: { jwks: JwkSetShape; expiresAt: number } | undefined;
  let inFlight: Promise<JwkSetShape> | undefined;

  return async () => {
    if (!cached || cached.expiresAt <= now()) {
      inFlight ??= (async () => {
        const response = await fetchImpl(options.jwksUri);
        if (!response.ok) throw new Error(`Fetching the trusted IdP JWKS failed with status ${response.status}`);
        return filterIdJagKeys(await response.json() as JwkSetShape);
      })().finally(() => { inFlight = undefined; });
      cached = { jwks: await inFlight, expiresAt: now() + CACHE_TTL_MS };
    }
    return [{ issuer: options.issuer, jwks: cached.jwks as never }];
  };
}
