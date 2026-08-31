import { serve } from '@hono/node-server';
import { readModes } from '@xaa/contracts';
import { createFirestoreDocumentStore, getFirestore } from '@xaa/gcp';
import { InMemoryJtiStore } from '@xaa/crypto';
import createApp from './index.js';
import { loadConfig } from './config.js';
import { createInternalClients } from './clients/http.js';
import { resolveEndpoints } from './endpoints.js';

const config = loadConfig();
const documents = createFirestoreDocumentStore(getFirestore(readModes(process.env)), 'lifecycle-manager');
const endpoints = resolveEndpoints(JSON.parse(process.env.PLATFORM_ENDPOINTS_JSON ?? '{}'));
const internal = createInternalClients({});

serve({
  fetch: createApp({
    config,
    documents,
    clients: {
      cloudRun: {
        async cancelExecution() { return 'not_found'; },
        async deleteService() { return 'not_found'; },
        async deleteJob() { return 'not_found'; },
      },
      kms: { async destroyCryptoKeyVersion() { return 'not_found'; } },
      iam: { async deleteServiceAccount() { return 'not_found'; }, async removeBinding() { return 'not_found'; } },
      jwks: { async deleteKey() { /* the bucket client is wired by the deployment */ } },
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
      jtiStore: new InMemoryJtiStore(),
      expectedHtu: (request: Request) => `${process.env.PUBLIC_BASE_URL ?? ''}${new URL(request.url).pathname}`,
    },
    internalAuth: {
      audience: process.env.PUBLIC_BASE_URL ?? '',
      allowedCallers: (process.env.ALLOWED_CALLER_SAS ?? '').split(',').filter(Boolean),
    },
  }).fetch,
  port: Number(process.env.PORT ?? 8080),
});
