import { FirestoreJtiStore, createFirestoreDocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createLifecycle, { createCleanupRunner, type LifecycleDeps } from '@xaa/lifecycle-manager/app';
import { createInternalClients } from '@xaa/lifecycle-manager/src/clients/http';
import { loadConfig } from '@xaa/lifecycle-manager/src/config';
import { resolveEndpoints } from '@xaa/lifecycle-manager/src/endpoints';
import { createIdentityDisabledHandler, startIdentityDisabledSubscriber } from '@xaa/lifecycle-manager/src/subscribers/runner';
import type { LocalRunPlatform } from '../local/cloud-run.js';
import { listen, type Listener } from '../local/serve.js';
import { TOPICS, type LocalPlatform } from '../platform.js';

export function lifecycleEnvironment(platform: LocalPlatform): Record<string, string> {
  const { url, projectId, region, endpoints } = platform.config.topology;
  return {
    PROJECT_ID: projectId,
    REGION: region,
    ISSUER: endpoints.issuer,
    PUBLIC_BASE_URL: url.lifecycle,
    FIRESTORE_DATABASE_ID: 'xaa-db',
    // Read from the platform config service rather than a bucket, but named the same
    // way and holding the same document.
    PLATFORM_ENDPOINTS_URI: `${url['platform-config']}/platform-endpoints.json`,
    AGENT_MAX_LIFETIME_SECONDS: String(platform.config.topology.agentMaxLifetimeSeconds),
    EXPIRING_WINDOW_SECONDS: '60',
    ACTIVITY_TOPIC: TOPICS.activity,
    JWKS_BUCKET: 'local-jwks',
    STORE_MODE: 'emulator',
    PUBSUB_MODE: 'inproc',
  };
}

/**
 * The Lifecycle Manager: the one way in and out of an agent's life.
 *
 * Its outbound calls all go out over HTTP with this service's own identity, exactly as
 * they do on GCP, so the Agent OP and the Resource Servers refuse anyone else asking
 * them to revoke. What is local is the destroy side — deleting the Cloud Run service, the
 * Job, the keys, the service accounts and the IAM bindings a `full_isolation` agent
 * owns — which is the local Cloud Run acting on the ledger rows the Provisioner wrote.
 *
 * The identity feed is subscribed to here, beside the app rather than inside it: a
 * disabled identity revokes agents without anybody making a request, and giving that a
 * route would be a second way to destroy an agent (RULE-28, T-LIFE-15).
 */
export function startLifecycle(platform: LocalPlatform, run: LocalRunPlatform): Listener {
  const config = loadConfig(lifecycleEnvironment(platform));
  const documents = createFirestoreDocumentStore(platform.firestore, 'lifecycle-manager');
  const endpoints = resolveEndpoints(platform.config.topology.endpoints);
  const internal = createInternalClients({
    identityToken: platform.identity.tokenProviderFor(platform.accounts.lifecycle!),
  });
  const publicBaseUrl = platform.config.topology.url.lifecycle;

  const deps: LifecycleDeps = {
    config,
    documents,
    clients: {
      ...run.cleanup,
      agentOp: internal,
      resourceAs: internal,
      bridge: internal,
      endpoints,
    },
    provisioner: internal,
    provisionerUrl: endpoints.provisionerUrl,
    accessToken: {
      issuer: config.issuer,
      jwksUrl: endpoints.jwksUrl,
      audience: config.selfAudience,
      requiredScope: 'agent:revoke',
      iatSkewSeconds: 300,
      jtiStore: new FirestoreJtiStore(platform.firestore),
      expectedHtu: (request: Request) => `${publicBaseUrl}${new URL(request.url).pathname}`,
    },
    internalAuth: {
      audience: publicBaseUrl,
      // The four callers Terraform names: the Authorization Platform, Security
      // Detection, Cloud Scheduler, and the Pub/Sub push identity.
      allowedCallers: [
        platform.accounts.authorization!, platform.accounts.security!,
        platform.accounts.scheduler!, platform.accounts.pubsubPush!,
      ],
      verify: (token, audience) => platform.identity.verify(token, audience),
    },
    publishActivity: async (event) => { await platform.pubsub.publish(TOPICS.activity, event); },
    // `sweepExtras` is deliberately absent. It collects resources the Provisioner
    // created and never managed to record, which it finds by listing a whole GCP
    // project by label — and every resource here is one this process owns and can
    // account for, so there is nothing for it to find.
  };

  const runCleanup = createCleanupRunner(deps);
  startIdentityDisabledSubscriber(
    platform.pubsub.pullSubscription(TOPICS.identityDisabled),
    createIdentityDisabledHandler({
      documents,
      logger: createLogger('lifecycle-manager', 'provisioner'),
      cleanup: runCleanup,
    }),
  );

  const app = createLifecycle(deps);
  return listen({
    name: 'lifecycle',
    host: platform.config.topology.host,
    port: platform.config.topology.port.lifecycle,
    fetch: (request) => app.fetch(request),
  });
}

/**
 * Cloud Scheduler's five-minute tick, as an interval.
 *
 * `/internal/tick` is what makes an expiry actually happen: nothing else notices that
 * an agent's time is up. It is gated on `sa-scheduler` and on nobody else, so the token
 * here is minted for that account — the same check the deployed service makes.
 */
export function startLifecycleTick(platform: LocalPlatform): { stop(): void } {
  const url = `${platform.config.topology.url.lifecycle}/internal/tick`;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const token = await platform.identity.mint(platform.config.topology.url.lifecycle, platform.accounts.scheduler!);
        await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      } catch {
        // A tick that could not be delivered is the next tick's problem, exactly as a
        // Cloud Scheduler attempt that failed is: `retry_count` is 0 in Terraform.
      }
    })();
  }, platform.config.lifecycleTickMs);
  timer.unref();
  return { stop: () => { clearInterval(timer); } };
}
