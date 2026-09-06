import { serve } from '@hono/node-server';
import { readModes } from '@xaa/contracts';
import { createJwksCache, verifyHumanIdToken } from '@xaa/crypto';
import { createFirestoreDocumentStore, getFirestore } from '@xaa/gcp';
import createApp from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const documents = createFirestoreDocumentStore(getFirestore(readModes(process.env)), 'analysis-console');
// The issuer's own endpoint rather than the bucket its metadata advertises: only tokens
// this issuer minted are verified with this set, and its own copy cannot lag a rotation.
const jwks = createJwksCache({ url: `${config.issuer}/.well-known/jwks.json` });

serve({
  fetch: createApp({
    config,
    documents,
    verifyIdToken: (token) => verifyHumanIdToken(token, {
      issuer: config.issuer, jwks, audience: config.clientId,
    }),
  }).fetch,
  port: config.port,
});
