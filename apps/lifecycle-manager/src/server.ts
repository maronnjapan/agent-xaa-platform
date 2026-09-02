import { serve } from '@hono/node-server';
import { PubSub } from '@google-cloud/pubsub';
import { readModes } from '@xaa/contracts';
import { createFirestoreDocumentStore, createIdentityTokenProvider, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import createApp, { createCleanupRunner, type LifecycleDeps } from './index.js';
import { loadConfig } from './config.js';
import { createInternalClients } from './clients/http.js';
import { resolveEndpoints } from './endpoints.js';
import { createLifecycleGcpClients } from './clients/gcp.js';
import { createOrphanCollector } from './clients/orphans.js';
import { createIdentityDisabledHandler, startIdentityDisabledSubscriber } from './subscribers/runner.js';
import { createLogger } from '@xaa/logging';

const config = loadConfig();
const firestore = getFirestore(readModes(process.env));
const documents = createFirestoreDocumentStore(firestore, 'lifecycle-manager');
const endpoints = resolveEndpoints(JSON.parse(process.env.PLATFORM_ENDPOINTS_JSON ?? '{}'));
const identityToken = createIdentityTokenProvider();
const internal = createInternalClients({ identityToken });
const jwksBucket = process.env.JWKS_BUCKET;
if (!jwksBucket) throw new Error('JWKS_BUCKET is required');
const gcp = createLifecycleGcpClients({ jwksBucket });

const deps: LifecycleDeps = {
  config,
  documents,
  clients: {
    ...gcp,
    agentOp: internal,
    resourceAs: internal,
    bridge: internal,
    endpoints,
  },
  provisioner: internal,
  provisionerUrl: endpoints.provisionerUrl,
  accessToken: {
    issuer: config.issuer,
    jwksUrl: `${config.issuer}/jwks.json`,
    audience: config.selfAudience,
    requiredScope: 'agent:revoke',
    iatSkewSeconds: 300,
    // Firestore, not memory: two revisions of this service must refuse the same replayed
    // proof, and an in-process set only refuses the one that happened to be seen twice.
    jtiStore: new FirestoreJtiStore(firestore),
    expectedHtu: (request: Request) => `${process.env.PUBLIC_BASE_URL ?? ''}${new URL(request.url).pathname}`,
  },
  internalAuth: {
    audience: process.env.PUBLIC_BASE_URL ?? '',
    allowedCallers: (process.env.ALLOWED_CALLER_SAS ?? '').split(',').filter(Boolean),
  },
  /**
   * DEC-IAC-25, sweep stage (e). Without this the tick has no way to see a resource the
   * Provisioner created and never managed to record, and the only thing that would ever
   * collect it is an operator running scripts/purge-runtime-resources.sh by hand.
   */
  sweepExtras: createOrphanCollector({
    projectId: config.projectId, region: config.region, clients: gcp,
  }),
};

/**
 * RULE-28, T-LIFE-15. Started beside the app, not inside it: a disabled identity
 * revokes agents without anybody making a request, and the feed is pulled because this
 * service takes INTERNAL_ONLY ingress (DEC-SEC-03).
 */
const identitySubscription = process.env.IDENTITY_DISABLED_SUBSCRIPTION;
if (!identitySubscription) throw new Error('IDENTITY_DISABLED_SUBSCRIPTION is required');
const runCleanup = createCleanupRunner(deps);
startIdentityDisabledSubscriber(
  new PubSub().subscription(identitySubscription),
  createIdentityDisabledHandler({
    documents,
    logger: createLogger('lifecycle-manager', 'provisioner'),
    cleanup: runCleanup,
  }),
);

serve({ fetch: createApp(deps).fetch, port: Number(process.env.PORT ?? 8080) });
