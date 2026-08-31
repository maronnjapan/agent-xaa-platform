import { Hono } from 'hono';
import { createLogger, type Logger } from '@xaa/logging';
import { InMemoryJtiStore, type JtiStore } from '@xaa/crypto';
import type { SigningKeyProvider } from '@maronn-openid-connect/core';
import { applyOidc } from './oidc/apply.js';
import { redeemDepsMiddleware } from './idjag/redeem.js';
import { createTrustedIdpResolver } from './config/trusted-idp.js';
import { createAsClientResolver } from './config/clients.js';
import { REGISTERED_SCOPES } from './config/registered-scopes.js';
import { loadResourceAsEnv, type ResourceAsEnv } from './config/env.js';
import type { SigningKeyMaterial } from './keys/self-bootstrap.js';
import type { RedeemStep } from '@xaa/resource-guard';

export interface ResourceAsDeps {
  env?: ResourceAsEnv;
  signingKey: SigningKeyMaterial;
  jtiStore?: JtiStore;
  fetchImpl?: typeof fetch;
  isActorRevoked?: (actorUrn: string) => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
  recordStep?: (step: RedeemStep) => void;
  /** Finance passes `full_isolation`; documents leaves it unset. */
  requireIsolationLevel?: string;
}

/**
 * A Resource AS redeems an ID-JAG and never issues one. `/authorize`, `/login`,
 * `/consent` and `/userinfo` are not mounted, and the discovery document is stripped
 * of the issuance advertisement below (DEC-ID-21).
 */
function createApp(deps: ResourceAsDeps): Hono {
  const env = deps.env ?? loadResourceAsEnv(process.env);
  const logger = deps.logger ?? createLogger('resource-docs-as', 'native_resource_as');

  const redeemDeps = {
    issuer: env.issuer,
    accessTokenExpiresIn: env.accessTokenExpiresIn,
    registeredScopes: env.registeredScopes,
    ...(deps.requireIsolationLevel ? { requireIsolationLevel: deps.requireIsolationLevel } : {}),
    identityProviders: createTrustedIdpResolver({
      issuer: env.trustedIdpIssuer, jwksUri: env.trustedIdpJwksUri,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
    jtiStore: deps.jtiStore ?? new InMemoryJtiStore(deps.now),
    ...(deps.isActorRevoked ? { isActorRevoked: deps.isActorRevoked } : {}),
    signingKey: { privateKey: deps.signingKey.privateKey, kid: deps.signingKey.kid },
    logger,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.recordStep ? { recordStep: deps.recordStep } : {}),
  };

  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  // Registered before applyOidc so the token route sees it (Hono runs handlers in
  // registration order).
  app.use('/token', redeemDepsMiddleware(redeemDeps));

  // DEC-ID-21: the generated discovery advertises that this OP can issue an ID-JAG.
  // It cannot, so the claim is removed from the response rather than the generated
  // file, which stays byte-identical to the baseline.
  app.use('/.well-known/openid-configuration', async (context, next) => {
    await next();
    if (!context.res.ok) return;
    const document = await context.res.json() as Record<string, unknown>;
    delete document.identity_chaining_requested_token_types_supported;
    context.res = Response.json(document, { headers: context.res.headers });
  });

  const provider: SigningKeyProvider = {
    async getSigningKey() { return { privateKey: deps.signingKey.privateKey, publicJwk: deps.signingKey.publicJwk as JsonWebKey, keyId: deps.signingKey.kid }; },
    async getSigningKeys() { return [{ privateKey: deps.signingKey.privateKey, publicJwk: deps.signingKey.publicJwk as JsonWebKey, keyId: deps.signingKey.kid }]; },
  };

  const clientResolver = createAsClientResolver();
  applyOidc(app, {
    config: { issuer: env.issuer, accessTokenExpiresIn: env.accessTokenExpiresIn, accessTokenFormat: 'jwt' },
    signingKeyProvider: provider,
    clientResolver,
    tokenClientResolver: clientResolver,
  });
  return app as unknown as Hono;
}

export { REGISTERED_SCOPES };
export default createApp;
