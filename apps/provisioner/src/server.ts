import { serve } from '@hono/node-server';
import createApp from './app.js';
import { createRuntimeDeps } from './runtime.js';

const deps = await createRuntimeDeps();
serve({ fetch: createApp(deps).fetch, port: deps.config.port });
