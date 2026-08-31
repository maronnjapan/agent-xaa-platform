import { serve } from '@hono/node-server';
import createApp from './app.js';
import { EnvValidationError, loadEnv } from './env.js';

try {
  const env = loadEnv();
  serve({ fetch: createApp({ env }).fetch, port: env.port });
} catch (error) {
  if (error instanceof EnvValidationError) {
    // Only the key names reach stderr. A secret's value must never be printed.
    process.stderr.write(`missing or invalid environment variables: ${error.missingKeys.join(', ')}\n`);
    process.exit(1);
  }
  throw error;
}
