import { verifyHumanAccessToken } from '@xaa/contracts';
import { createJwksCache, verifyHumanIdToken } from '@xaa/crypto';
import { createFirestoreDocumentStore } from '@xaa/gcp';
import createAutomationApp from '@xaa/automation-app/app';
import { humanIdpJwksUrl } from '@xaa/automation-app/src/auth/oidc-login';
import { loadConfig } from '@xaa/automation-app/src/config';
import { listen, type Listener } from '../local/serve.js';
import { TOPICS, type LocalPlatform } from '../platform.js';

export function automationAppEnvironment(platform: LocalPlatform): Record<string, string> {
  const { url, endpoints } = platform.config.topology;
  return {
    ISSUER: endpoints.issuer,
    PUBLIC_BASE_URL: url['automation-app'],
    AUTHORIZATION_PLATFORM_URL: url.authorization,
    AGENT_PROVISIONER_URL: url.provisioner,
    LIFECYCLE_MANAGER_URL: url.lifecycle,
    DOCS_API_URL: endpoints.resource_docs_api_url,
    ANALYSIS_CONSOLE_URL: url['analysis-console'],
    ACTIVITY_TOPIC: TOPICS.activity,
    AGENT_MAX_LIFETIME_SECONDS: String(platform.config.topology.agentMaxLifetimeSeconds),
    CLIENT_SECRET_AUTOMATION_APP: platform.secrets.automationApp,
    VERTEX_MODEL: platform.config.topology.vertexModel,
    VERTEX_MODE: 'fake',
    STORE_MODE: 'emulator',
  };
}

/**
 * The screen a person opens, and the only place they touch the platform.
 *
 * It verifies the tokens in a session against the Human IdP's own JWK Set, over HTTP,
 * the way the deployment does — the login really is an OAuth round trip through the
 * IdP on its own port, and the redirect really does come back to `/callback` here.
 * The one substitution is Cloud Run's identity: the token this app presents when it
 * reads a document as itself, and the token it demands from a Pub/Sub push delivery.
 */
export function startAutomationApp(platform: LocalPlatform): Listener {
  const config = loadConfig(automationAppEnvironment(platform));
  const jwks = createJwksCache({ url: humanIdpJwksUrl(config.issuer) });
  const app = createAutomationApp({
    config,
    documents: createFirestoreDocumentStore(platform.firestore, 'automation-app'),
    verifyAccessToken: (token) => verifyHumanAccessToken(token, { issuer: config.issuer, jwks, audience: config.clientId }),
    verifyIdToken: (token) => verifyHumanIdToken(token, { issuer: config.issuer, jwks, audience: config.clientId }),
    identityTokenProvider: platform.identity.tokenProviderFor(platform.accounts.automationApp!),
    verifyPush: async (input) => {
      const token = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7) : undefined;
      if (!token) throw new Error('missing push token');
      const email = await platform.identity.verify(token, input.audience);
      // The same whole-string check `verifyPushCaller` makes: only the subscription's
      // own service account may write into a person's timeline.
      if (email !== platform.accounts.pubsubPush) throw new Error('unexpected push caller');
      return { email };
    },
  });
  return listen({
    name: 'automation-app',
    host: platform.config.topology.host,
    port: platform.config.topology.port['automation-app'],
    fetch: (request) => app.fetch(request),
  });
}
