import { serve } from '@hono/node-server';
import { createFirestoreDocumentStore, createIdentityTokenProvider, getFirestore } from '@xaa/gcp';
import { readModes, verifyHumanAccessToken } from '@xaa/contracts';
import { createJwksCache, verifyHumanIdToken } from '@xaa/crypto';
import createApp from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const documents = createFirestoreDocumentStore(getFirestore(readModes(process.env)), 'automation-app');
const jwks = createJwksCache({ url: `${config.issuer}/jwks.json` });
const identityTokenProvider = createIdentityTokenProvider();

serve({
  fetch: createApp({
    config,
    documents,
    verifyAccessToken: (token) => verifyHumanAccessToken(token, {
      issuer: config.issuer, jwks, audience: config.clientId,
    }),
    verifyIdToken: (token) => verifyHumanIdToken(token, {
      issuer: config.issuer, jwks, audience: config.clientId,
    }),
    identityTokenProvider,
  }).fetch,
  port: config.port,
});
