import { serve } from '@hono/node-server';
import { readModes } from '@xaa/contracts';
import { createFirestoreDocumentStore, getFirestore } from '@xaa/gcp';
import createApp from './index.js';
import { analyze } from './ai/vertex-client.js';

const documents = createFirestoreDocumentStore(getFirestore(readModes(process.env)), 'security-detection');

serve({
  fetch: createApp({
    documents,
    // The one outbound destination this service has.
    sendToLifecycle: async (request) => globalThis.fetch(
      new URL('/internal/security/transition', process.env.LIFECYCLE_MANAGER_URL ?? '').toString(),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
    ),
    analyze,
    ...(process.env.RESOURCE_FINANCE_API_URL ? { financeResourceUrl: process.env.RESOURCE_FINANCE_API_URL } : {}),
  }).fetch,
  port: Number(process.env.PORT ?? 8080),
});
