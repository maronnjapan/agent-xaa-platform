import { Hono } from 'hono';

export const healthzApp = new Hono();
healthzApp.get('/', (context) => context.json({ status: 'ok', app: 'agent-op' }));
