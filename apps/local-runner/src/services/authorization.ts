import createAuthorization from '@xaa/authorization/app';
import { loadConfig } from '@xaa/authorization/src/config';
import { createReprovisionClient } from '@xaa/authorization/src/reevaluate/reprovision-client';
import { FirestoreJtiStore, createFirestoreDocumentStore } from '@xaa/gcp';
import { listen, type Listener } from '../local/serve.js';
import { TOPICS, type LocalPlatform } from '../platform.js';

export function authorizationEnvironment(platform: LocalPlatform): Record<string, string> {
  const { url, projectId, region, endpoints } = platform.config.topology;
  return {
    PROJECT_ID: projectId,
    REGION: region,
    ISSUER: endpoints.issuer,
    PUBLIC_BASE_URL: url.authorization,
    JWKS_URL: endpoints.jwks_url,
    AUTHZ_AUDIENCE: 'authorization-platform',
    LIFECYCLE_MANAGER_URL: url.lifecycle,
    DPOP_IAT_SKEW_SECONDS: '60',
    ACTIVITY_TOPIC: TOPICS.activity,
    TAXONOMY_VERSION: 'v1',
    AGENT_MAX_LIFETIME_SECONDS: String(platform.config.topology.agentMaxLifetimeSeconds),
    ADMIN_PRINCIPALS: platform.config.adminPrincipals.join(','),
    STORE_MODE: 'emulator',
    PUBSUB_MODE: 'inproc',
    VERTEX_MODE: 'fake',
    VERTEX_MODEL: platform.config.topology.vertexModel,
    VERTEX_LOCATION: platform.config.topology.vertexLocation,
  };
}

/**
 * The Authorization Platform, which decides what an agent may do.
 *
 * Nothing about the decision is local. The model is whichever one this run configured
 * — `VERTEX_MODE` here says `fake` because the mode variable only selects between the
 * two clients this app can build for itself, and the client it is handed instead is the
 * platform's, chosen once in `platform.ts`. What is local is the Activity publisher and
 * the console's identity check, which are Pub/Sub and Cloud Run rather than policy.
 */
export function startAuthorization(platform: LocalPlatform): Listener {
  const config = loadConfig(authorizationEnvironment(platform));
  const app = createAuthorization({
    config,
    documents: createFirestoreDocumentStore(platform.firestore, 'authorization'),
    vertex: platform.model,
    jtiStore: new FirestoreJtiStore(platform.firestore),
    publishActivity: async (event) => { await platform.pubsub.publish(TOPICS.activity, event); },
    requestReprovision: createReprovisionClient({
      lifecycleBaseUrl: config.lifecycleManagerUrl,
      identityToken: platform.identity.tokenProviderFor(platform.accounts.authorization!),
    }),
    verifyAdmin: (token, audience) => platform.identity.verify(token, audience),
  });
  return listen({
    name: 'authorization',
    host: platform.config.topology.host,
    port: platform.config.topology.port.authorization,
    fetch: (request) => app.fetch(request),
  });
}
