import { Hono } from 'hono';

/**
 * The liveness route, mounted at `/livez` rather than the `/healthz` this file is
 * named after: the Google Frontend answers `GET /healthz` on every `*.run.app` host
 * itself and never forwards it to the container (infra/spike/RESULT.md (c)).
 */
export const healthzApp = new Hono();
healthzApp.get('/', (context) => context.json({ status: 'ok', app: 'agent-op' }));
