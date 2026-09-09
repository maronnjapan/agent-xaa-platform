import { publishJwks, waitForIssuerJwks } from './index.js';

if (!process.env.JWKS_BUCKET) throw new Error('JWKS_BUCKET is required');
if (!process.env.HUMAN_IDP_JWKS_URL) throw new Error('HUMAN_IDP_JWKS_URL is required');

// The order is the whole point: the Human IdP writes its `keys/<kid>.json` while
// answering the request below, so reading the bucket first is reading it too early.
await waitForIssuerJwks(process.env.HUMAN_IDP_JWKS_URL);
await publishJwks(process.env.JWKS_BUCKET);
