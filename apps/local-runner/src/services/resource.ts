import { DOCS_SCOPES, FINANCE_SCOPES } from '@xaa/contracts';
import { FirestoreJtiStore, createFirestoreDocumentStore } from '@xaa/gcp';
import { createRevocationLedger } from '@xaa/resource-guard';
import createDocsAs from '@xaa/resource-docs-as/app';
import createFinanceAs from '@xaa/resource-finance-as/app';
import createDocsApi from '@xaa/resource-docs-api/app';
import createFinanceApi from '@xaa/resource-finance-api/app';
import { loadResourceAsEnv } from '@xaa/resource-docs-as/src/config/env';
import { generateLocalSigningJwk, localSigningKey } from '@xaa/resource-docs-as/src/keys/self-bootstrap';
import { createResourceAsStores } from '@xaa/resource-docs-as/src/store/backend';
import { createResourceAsStores as createFinanceAsStores } from '@xaa/resource-finance-as/src/store/backend';
import { publishable } from '../local/jwks.js';
import { listen, type Listener } from '../local/serve.js';
import type { LocalPlatform } from '../platform.js';

export type ResourceKind = 'docs' | 'finance';

const KID_PREFIX = { docs: 'docs-as', finance: 'fin-as' } as const;

export function resourceAsEnvironment(platform: LocalPlatform, kind: ResourceKind): Record<string, string> {
  const { url, endpoints } = platform.config.topology;
  const asName = kind === 'docs' ? 'resource-docs-as' : 'resource-finance-as';
  const apiName = kind === 'docs' ? 'resource-docs-api' : 'resource-finance-api';
  return {
    PUBLIC_BASE_URL: url[asName],
    AS_KIND: kind,
    ISSUER: url[asName],
    RESOURCE: url[apiName],
    TRUSTED_IDP_ISSUER: endpoints.issuer,
    TRUSTED_IDP_JWKS_URI: endpoints.jwks_url,
    REGISTERED_SCOPES: (kind === 'docs' ? DOCS_SCOPES : FINANCE_SCOPES).join(' '),
    SIGNING_KEY_BUCKET: 'local-platform-config',
    SIGNING_KEY_OBJECT: `signing/${asName}.json`,
    SIGNING_KEY_KMS_KEY: kind === 'docs' ? platform.keys.resourceDocsAs : platform.keys.resourceFinanceAs,
    JWKS_BUCKET: 'local-jwks',
    JWKS_KEY_PREFIX: KID_PREFIX[kind],
    SIGNER_MODE: 'local',
    STORE_MODE: 'emulator',
    // T-RES-19: the Finance AS refuses to redeem for a standard agent, the twin of the
    // gate on the Finance API. Documents sets neither.
    ...(kind === 'finance' ? { REQUIRE_ISOLATION_LEVEL: 'full_isolation' } : {}),
  };
}

/**
 * One Resource Server: the Authorization Server that redeems an ID-JAG, and the API
 * that the resulting Access Token opens.
 *
 * The AS signs with an RSA key generated at startup — which is what `SIGNER_MODE=local`
 * already means in this codebase — and publishes it into the platform's aggregate JWK
 * Set, because that is the set the API in front of it verifies against. Both halves
 * share one revocation ledger, as they do in a single Cloud Run process, so an actor
 * revoked at the AS is refused at the API without waiting for a cache to expire.
 */
export async function startResource(platform: LocalPlatform, kind: ResourceKind): Promise<Listener[]> {
  const { host, port, endpoints } = platform.config.topology;
  const asName = kind === 'docs' ? 'resource-docs-as' : 'resource-finance-as';
  const apiName = kind === 'docs' ? 'resource-docs-api' : 'resource-finance-api';
  const env = loadResourceAsEnv(
    resourceAsEnvironment(platform, kind),
    kind === 'docs' ? DOCS_SCOPES : FINANCE_SCOPES,
  );
  const signingKey = await localSigningKey(await generateLocalSigningJwk(), KID_PREFIX[kind]);
  platform.jwks.publish(publishable(signingKey.publicJwk, signingKey.kid, 'RS256'));

  const documents = createFirestoreDocumentStore(platform.firestore, apiName);
  const ledger = createRevocationLedger(documents);
  const { stores, storeAccessToken } = kind === 'docs'
    ? createResourceAsStores(platform.firestore)
    : createFinanceAsStores(platform.firestore);

  const asApp = kind === 'docs'
    ? createDocsAs({
      env, signingKey, stores, storeAccessToken,
      jtiStore: new FirestoreJtiStore(platform.firestore),
      isActorRevoked: (urn) => ledger.isActorRevoked(urn),
    })
    : createFinanceAs({
      env, signingKey, stores, storeAccessToken,
      jtiStore: new FirestoreJtiStore(platform.firestore),
      isActorRevoked: (urn) => ledger.isActorRevoked(urn),
      requireIsolationLevel: 'full_isolation',
    });

  const serviceIdentity = {
    async verify(authorization: string | undefined) {
      const token = authorization?.match(/^Bearer (.+)$/)?.[1];
      return token ? platform.identity.verify(token, env.resourceUri) : null;
    },
  };
  const shared = {
    documents,
    asIssuer: env.issuer,
    resourceUri: env.resourceUri,
    jwksUrl: endpoints.jwks_url,
    jtiStore: new FirestoreJtiStore(platform.firestore),
    serviceIdentity,
    lifecycleServiceAccount: platform.accounts.lifecycle!,
    revocationLedger: ledger,
  };
  const apiApp = kind === 'docs'
    ? createDocsApi({
      ...shared,
      // T-APP-05: the one other caller the Documents API ever admits, and only for a
      // daily report it writes for the person in front of the screen.
      automationAppServiceAccount: platform.accounts.automationApp!,
      publicBaseUrl: platform.config.topology.url[apiName],
      adminPrincipals: platform.config.adminPrincipals,
      verifyAdmin: (token: string, audience: string) => platform.identity.verify(token, audience),
    })
    : createFinanceApi({ ...shared, absoluteMaxAmount: platform.config.topology.financeAbsoluteMaxAmount });

  return [
    listen({ name: asName, host, port: port[asName], fetch: (request) => asApp.fetch(request) }),
    listen({ name: apiName, host, port: port[apiName], fetch: (request) => apiApp.fetch(request) }),
  ];
}
