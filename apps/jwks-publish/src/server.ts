import { publishJwks } from './index.js';
if (!process.env.JWKS_BUCKET) throw new Error('JWKS_BUCKET is required');
await publishJwks(process.env.JWKS_BUCKET);
