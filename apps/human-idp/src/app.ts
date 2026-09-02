import { Hono } from 'hono';
import { createJtiStore } from './gcp.js';
import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import type { SigningKeyProvider } from '@maronn-openid-connect/core';
import { applyOidc } from './oidc/apply.js';
import type { ProviderStores } from './oidc/store.js';
import { loadEnv, type HumanIdpEnv } from './env.js';
import { createClientRegistry, createRegistryResolver } from './config/clients.js';
import { createOfflineAccessPolicy } from './auth/offline-access-policy.js';
import { createAuditHooks } from './log/audit-log.js';
import { createHumanIdpStores } from './store/provider-stores.js';
import { createHumanIdpSigningKeyProvider } from './keys/signing-key-provider.js';
import { bootstrapSigningKey } from './keys/self-bootstrap.js';
import { createBucketStore, createDocumentStore, createKmsEnvelope } from './gcp.js';

export interface HumanIdpDeps {
  env?: HumanIdpEnv;
  /** Test seam for the audit sink; production writes JSON lines to stdout. */
  writeAuditLine?: (line: string) => void;
  stores?: ProviderStores;
  signingKeyProvider?: SigningKeyProvider;
  jtiStore?: JtiStore;
}

/**
 * DEC-APP-07: the app is a factory so integration tests can call `app.fetch(request)`
 * without a listening socket. `serve()` belongs to server.ts alone.
 */
function createApp(deps: HumanIdpDeps = {}): Hono {
  const env = deps.env ?? loadEnv();
  const registry = createClientRegistry(env);
  const resolver = createRegistryResolver(registry);

  let resolved: { stores: ProviderStores; jtiStore: JtiStore } | undefined;
  const resolve = () => {
    if (resolved) return resolved;
    if (deps.stores && deps.jtiStore) {
      resolved = { stores: deps.stores, jtiStore: deps.jtiStore };
      return resolved;
    }
    const documentStore = createDocumentStore(env);
    resolved = {
      stores: deps.stores ?? createHumanIdpStores(documentStore).stores,
      jtiStore: deps.jtiStore ?? createJtiStore(env),
    };
    return resolved;
  };

  const signingKeyProvider = deps.signingKeyProvider ?? createHumanIdpSigningKeyProvider(() => bootstrapSigningKey({
    store: createBucketStore(env.keyBucket),
    jwksStore: createBucketStore(env.jwksBucket),
    envelope: createKmsEnvelope(env.kmsSsoKeyName),
  }));

  // The generated routes exchange values through context variables, so the app is
  // typed with an open Variables map and narrowed back to Hono at the boundary.
  const auditHooks = createAuditHooks(deps.writeAuditLine);
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.get('/healthz', (context) => context.json({ status: 'ok', app: 'human-idp' }));

  // Everything the patched generated routes read is set here. Hono runs handlers in
  // registration order, so this must precede applyOidc: a middleware registered
  // after the routes are mounted would never run before them.
  app.use('*', async (context, next) => {
    const { stores, jtiStore } = resolve();
    context.set('jwksPublicBaseUrl', env.jwksPublicBaseUrl);
    context.set('issuerProfile', env.issuerProfile);
    context.set('dpopRequired', env.dpopRequired);
    context.set('jtiStore', jtiStore);
    context.set('auditHooks', auditHooks);
    context.set('offlineAccessPolicy', createOfflineAccessPolicy({
      consentStore: stores.consentStore,
      browserSessionStore: stores.browserSessionStore,
    }));
    await next();
  });

  applyOidc(app, {
    config: {
      issuer: env.issuer,
      accessTokenExpiresIn: env.accessTokenExpiresIn,
      accessTokenFormat: 'jwt',
      onlineRefreshTokenEnabled: true,
    },
    signingKeyProvider,
    clientResolver: resolver,
    tokenClientResolver: resolver,
    // The session and consent resolvers applyOidc installs are derived from these
    // same stores, so prompt=none reads the persistent records, not the generated
    // in-memory defaults.
    storage: () => resolve().stores,
  });

  return app as unknown as Hono;
}

export { InMemoryJtiStore };

export default createApp;
