import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authorizeApp } from './routes/authorize.js';
import { tokenApp } from './routes/token.js';
import { userinfoApp } from './routes/userinfo.js';
import { introspectionApp } from './routes/introspection.js';
import { revocationApp } from './routes/revocation.js';
import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginApp } from './routes/login.js';
import { consentApp } from './routes/consent.js';
import {
  createInMemoryClientResolver,
  createProviderConfig,
  type ProviderConfig,
} from './config.js';
import {
  createStoreResolvers,
} from './resolvers.js';
import {
  defaultProviderStores,
  type ProviderStores,
  type ProviderStoresFactory,
} from './store.js';
import { createViews, type Views } from './views.js';
import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  getRegisteredSigningKeys,
  signingKeysToJwkSet,
} from '@maronn-openid-connect/core';
import type {
  SigningKey,
  SigningKeyProvider,
  ClientResolver,
  TokenClientResolver,
  AcrResolver,
  SessionResolver,
  ConsentResolver,
  JwkSet,
} from '@maronn-openid-connect/core';

export type CorsOrigins = string | string[];

export interface CreateAppOptions {
  config?: Partial<ProviderConfig>;
  /**
   * Provider for the RSA signing key pair.
   * Must load keys from your secret store (env var, KV, D1, etc.).
   * Use createCachedSigningKeyProvider() to refresh the key periodically.
   * Note: JWKS serves only the current key. Tokens signed with a rotated-out
   * key will fail verification after the provider returns a new key.
   */
  signingKeyProvider: SigningKeyProvider;
  idTokenSigningKeyProvider?: SigningKeyProvider;
  userinfoSigningKeyProvider?: SigningKeyProvider;
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  /**
   * Session resolver used for SSO / prompt=none / max_age
   * (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
   * Defaults to the cookie-based browser session resolver in resolvers.ts.
   */
  sessionResolver?: SessionResolver;
  /**
   * Consent resolver used by prompt=none to confirm prior consent without UI
   * (OIDC Core 1.0 Section 3.1.2.1).
   * Defaults to the in-memory consent store resolver in resolvers.ts.
   */
  consentResolver?: ConsentResolver;
  /** Persistent stores, or a request-aware factory for bindings such as Cloudflare D1. */
  storage?: ProviderStores | ProviderStoresFactory;
  acrResolver?: AcrResolver;
  /**
   * Custom UI for the login / consent / error pages.
   * Provide any subset; omitted pages fall back to the default views.
   * Inject your own UI here instead of editing views.ts.
   */
  views?: Partial<Views>;
  /**
   * JWKS provider used to verify id_token_hint (OIDC Core 1.0 §3.1.2.2).
   * Omit to use the OP's own ID Token signing keys by default, so an ID Token
   * the OP issued can be presented back as id_token_hint without extra wiring.
   * Override only when hints are signed by a different key set.
   */
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
  corsOrigins?: CorsOrigins;
}

export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): void {
  assertKeyStrength(keys);
  assertKidStrategyConsistent(keys);
  if (requireRs256) {
    assertHasRs256Key(keys.map((key) => key.privateKey));
  }
}

const OIDC_ENDPOINT_METHODS: Readonly<Record<string, readonly string[]>> = {
  '/authorize': ['GET', 'POST'],
  '/token': ['POST'],
  '/userinfo': ['GET', 'POST'],
  '/introspect': ['POST'],
  '/revoke': ['POST'],
  '/.well-known/jwks.json': ['GET'],
  '/.well-known/openid-configuration': ['GET'],
  '/login': ['GET', 'POST'],
  '/consent': ['GET', 'POST'],
};

async function enforceOidcEndpointMethod(c: any, next: () => Promise<void>): Promise<Response | void> {
  const pathname = new URL(c.req.url).pathname;
  const allowed = OIDC_ENDPOINT_METHODS[pathname];
  const method = c.req.method;
  // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
  // supported. HEAD shares GET semantics (§9.3.2), so let it through on any
  // GET-allowing endpoint; Hono runs the GET handler and strips the body.
  const isHeadOnGet = method === 'HEAD' && (allowed?.includes('GET') ?? false);
  if (allowed && !allowed.includes(method) && !isHeadOnGet) {
    c.header('Allow', allowed.join(', '));
    return c.body(null, 405);
  }
  await next();
}


/**
 * Initialize the OpenID Connect Provider.
 * Mounts middleware and routes onto the app instance.
 */
export function createApp(options: CreateAppOptions): Hono<{ Variables: Record<string, any> }> {
  // A factory must return an isolated router each time. Keeping this instance at
  // module scope makes later createApp calls reuse a matcher whose routes were
  // already finalized and also leaks the first call's middleware/options.
  const app = new Hono<{ Variables: Record<string, any> }>();
  const corsOrigins = options.corsOrigins ?? '*';
  const protectedCors = cors({
    origin: corsOrigins,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  const publicCors = cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 600 });
  app.use('/token', protectedCors);
  app.use('/userinfo', protectedCors);
  app.use('/introspect', protectedCors);
  app.use('/revoke', protectedCors);
  app.use('/.well-known/openid-configuration', publicCors);
  app.use('/.well-known/jwks.json', publicCors);
  // CORS must run first so OPTIONS preflights are answered before method enforcement.
  app.use('*', enforceOidcEndpointMethod);

  // Store runtime dependencies for use by routes.
  app.use('*', async (c, next) => {
    let signingKey;
    let idTokenSigningKey;
    let userinfoSigningKey;
    let signingKeys;
    let idTokenSigningKeys;
    let userinfoSigningKeys;
    try {
      signingKey = await options.signingKeyProvider.getSigningKey();
      // T-022: surface every registered key so JWKS/Discovery can advertise
      // rotated-out and alternate-alg keys, not just the active signing key.
      signingKeys = await getRegisteredSigningKeys(options.signingKeyProvider);
      const idProvider = options.idTokenSigningKeyProvider ?? options.signingKeyProvider;
      idTokenSigningKey = await idProvider.getSigningKey();
      idTokenSigningKeys = await getRegisteredSigningKeys(idProvider);
      const uiProvider = options.userinfoSigningKeyProvider ?? options.signingKeyProvider;
      userinfoSigningKey = await uiProvider.getSigningKey();
      userinfoSigningKeys = await getRegisteredSigningKeys(uiProvider);
      validateSigningKeySet(signingKeys);
      validateSigningKeySet(idTokenSigningKeys, true);
      validateSigningKeySet(userinfoSigningKeys);
    } catch {
      return c.json({ error: 'server_error', error_description: 'Failed to load signing key' }, 503);
    }
    const { privateKey, publicJwk, keyId } = signingKey;
    const clientResolver =
      options.clientResolver ?? createInMemoryClientResolver();
    const stores = await resolveProviderStores(options.storage, c);
    const storeResolvers = createStoreResolvers(stores);

    c.set('privateKey', privateKey);
    c.set('publicJwk', publicJwk);
    c.set('keyId', keyId);
    c.set('signingKeys', signingKeys);
    c.set('idTokenPrivateKey', idTokenSigningKey.privateKey);
    c.set('idTokenPublicJwk', idTokenSigningKey.publicJwk);
    c.set('idTokenKeyId', idTokenSigningKey.keyId);
    c.set('userinfoPrivateKey', userinfoSigningKey.privateKey);
    c.set('userinfoPublicJwk', userinfoSigningKey.publicJwk);
    c.set('userinfoKeyId', userinfoSigningKey.keyId);
    c.set('idTokenSigningKeys', idTokenSigningKeys);
    c.set('userinfoSigningKeys', userinfoSigningKeys);
    c.set('config', createProviderConfig(options.config));
    c.set('clientResolver', clientResolver);
    c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);
    c.set('transactionStore', stores.transactionStore);
    c.set('authCodeStore', stores.authCodeStore);
    c.set('accessTokenStore', stores.accessTokenStore);
    c.set('refreshTokenStore', stores.refreshTokenStore);
    c.set('authSessionStore', stores.authSessionStore);
    c.set('browserSessionStore', stores.browserSessionStore);
    c.set('authenticateUser', (username: string, password: string) =>
      stores.userStore.authenticate(username, password));
    c.set('authCodeResolver', storeResolvers.authorizationCodeResolver);
    c.set('accessTokenResolver', storeResolvers.accessTokenResolver);
    c.set('userClaimsResolver', storeResolvers.userClaimsResolver);
    c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);
    c.set('authenticationSessionResolver', storeResolvers.authenticationSessionResolver);
    c.set('introspectionAccessTokenResolver', storeResolvers.introspectionAccessTokenResolver);
    c.set('introspectionRefreshTokenResolver', storeResolvers.introspectionRefreshTokenResolver);
    c.set('revocationResolvers', storeResolvers.revocationResolvers);

    // P1: default cookie-based session + consent resolvers so prompt=none /
    // max_age / SSO work out of the box (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
    c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
    c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
    if (options.acrResolver) {
      c.set('acrResolver', options.acrResolver);
    }
    // Inject custom UI (login / consent / error) merged over the defaults.
    c.set('views', createViews(options.views));
    // Default jwksProvider verifies id_token_hint against the OP's own ID Token
    // signing keys (OIDC Core 1.0 §3.1.2.2) so a hint the OP issued validates out
    // of the box. An explicit options.jwksProvider overrides it. The closure
    // captures this request's key set so it reflects the latest rotation.
    c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)));
    await next();
  });

  app.route('/authorize', authorizeApp);
  app.route('/token', tokenApp);
  app.route('/userinfo', userinfoApp);
  app.route('/introspect', introspectionApp);
  app.route('/revoke', revocationApp);
  app.route('/.well-known/jwks.json', jwksApp);
  app.route('/.well-known/openid-configuration', discoveryApp);
  app.route('/login', loginApp);
  app.route('/consent', consentApp);

  return app;
}

async function resolveProviderStores(
  storage: CreateAppOptions['storage'],
  context: any,
): Promise<ProviderStores> {
  if (!storage) return defaultProviderStores;
  return typeof storage === 'function' ? storage(context) : storage;
}
