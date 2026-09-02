import { serve } from '@hono/node-server';
import createApp from './app.js';
import { createRuntimeDeps } from './runtime.js';

// A rejection here is deliberately unhandled: a process that cannot publish its
// signing key must exit non-zero rather than serve (T-OP-05).
const deps = await createRuntimeDeps();
serve({ fetch: createApp(deps).fetch, port: deps.port });
