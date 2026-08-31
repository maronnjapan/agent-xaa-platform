import { serve } from '@hono/node-server';
import createApp from './index.js';

serve({ fetch: createApp().fetch, port: Number(process.env.PORT ?? 8080) });
