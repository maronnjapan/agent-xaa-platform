export type PublishedJwk = JsonWebKey & { kid: string; alg: string; use: 'sig' };

/**
 * The platform's aggregate JWK Set, held in memory.
 *
 * On GCP this is an object in a bucket: every signing service writes its own public key
 * under `keys/<kid>.json`, the `jwks-publish` Job merges them into `jwks.json`, and
 * every verifier reads that one URL. The merge is the part that matters — a Resource
 * Server verifies an Agent OP grant against the same set that carries the Human IdP's
 * SSO key — and it is reproduced here rather than skipped, because a local platform
 * where each service trusted only its own key would verify nothing the deployed one
 * verifies.
 *
 * A Dedicated OP publishes its key at provisioning time, so the set grows while the
 * platform is running; the served document is built per request for that reason.
 */
export function createLocalJwks(): {
  publish(key: PublishedJwk): void;
  remove(kid: string): void;
  document(): { keys: PublishedJwk[] };
} {
  const keys = new Map<string, PublishedJwk>();
  return {
    publish(key) { keys.set(key.kid, key); },
    remove(kid) { keys.delete(kid); },
    document() { return { keys: [...keys.values()] }; },
  };
}

export type LocalJwks = ReturnType<typeof createLocalJwks>;

/**
 * The public half of a key, in the shape a JWK Set entry takes.
 *
 * `key_ops` and `ext` describe a WebCrypto handle rather than a published key, and a
 * verifier that imports a JWK carrying them can be refused the operation it needs.
 * `d` is the private exponent, and a JWK Set is served to everybody.
 */
export function publishable(jwk: JsonWebKey, kid: string, alg: string): PublishedJwk {
  const publicOnly = Object.fromEntries(
    Object.entries(jwk).filter(([name]) => !['key_ops', 'ext', 'd', 'p', 'q', 'dp', 'dq', 'qi'].includes(name)),
  );
  return { ...publicOnly, kid, alg, use: 'sig' };
}
