import { serve } from '@hono/node-server';
import { createFirestoreDocumentStore, getFirestore } from '@xaa/gcp';
import { readModes, verifyHumanAccessToken } from '@xaa/contracts';
import { createJwksCache } from '@xaa/crypto';
import createApp from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const documents = createFirestoreDocumentStore(getFirestore(readModes(process.env)), 'automation-app');
const jwks = createJwksCache({ url: `${config.issuer}/jwks.json` });

serve({
  fetch: createApp({
    config,
    documents,
    verifyAccessToken: (token) => verifyHumanAccessToken(token, {
      issuer: config.issuer, jwks, audience: config.clientId,
    }),
  }).fetch,
  port: config.port,
});
