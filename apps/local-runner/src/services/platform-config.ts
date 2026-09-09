import { Hono } from 'hono';
import { listen, type Listener } from '../local/serve.js';
import type { LocalPlatform } from '../platform.js';

/**
 * The platform config bucket, served over HTTP.
 *
 * Two objects live in it on GCP and both are read by URL rather than by SDK: the
 * aggregate `jwks.json` that every verifier fetches, and `platform-endpoints.json`,
 * which is where each service learns the addresses of the others. Serving them from a
 * port rather than handing them to each service as a value keeps the fetch real — a
 * Resource Server verifying an Agent OP grant really does go and get the key, cache it,
 * and find a Dedicated OP's key there when one is published mid-run.
 */
export function startPlatformConfig(platform: LocalPlatform): Listener {
  const app = new Hono();
  app.get('/livez', (context) => context.json({ status: 'ok', app: 'platform-config' }));
  app.get('/jwks.json', (context) => context.json(platform.jwks.document()));
  app.get('/platform-endpoints.json', (context) => context.json(platform.config.topology.endpoints));
  return listen({
    name: 'platform-config',
    host: platform.config.topology.host,
    port: platform.config.topology.port['platform-config'],
    fetch: (request) => app.fetch(request),
  });
}
