import { Hono } from 'hono';
function createApp(): Hono { const app = new Hono(); app.get('/healthz', (context) => context.json({ status: 'ok', app: 'stub-saas-api' })); return app; }

export default createApp;
