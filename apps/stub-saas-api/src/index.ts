import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { RESOURCE_SCOPES } from '@xaa/contracts';

export interface StubSaasApiDeps {
  signingSecret?: string;
  now?: () => number;
}

const CALENDAR_READ = RESOURCE_SCOPES.find((scope) => scope.startsWith('calendar.'))!;

export const STUB_EVENTS = [
  { event_id: 'evt-001', title: '週次ミーティング', starts_at: '2026-01-05T01:00:00.000Z' },
  { event_id: 'evt-002', title: '経費精算の締め切り', starts_at: '2026-01-06T09:00:00.000Z' },
  { event_id: 'evt-003', title: '四半期レビュー', starts_at: '2026-01-08T05:00:00.000Z' },
];

/**
 * A stand-in for the external SaaS's business API.
 *
 * It accepts a plain `Authorization: Bearer` and nothing else. There is no DPoP branch
 * here on purpose (REQ-05-023): a token minted by an external SaaS is presented the way
 * that SaaS expects, and the Bridge test would prove nothing if the stub demanded the
 * platform's own binding scheme.
 */
function createApp(deps: StubSaasApiDeps = {}): Hono {
  const signingSecret = deps.signingSecret ?? 'stub-shared-hmac-secret';
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();

  app.get('/livez', (context) => context.json({ status: 'ok', app: 'stub-saas-api' }));

  app.get('/calendar/events', (context) => {
    const header = context.req.header('authorization');
    if (!header?.startsWith('Bearer ')) return context.json({ error: 'unauthorized' }, 401);
    const claims = verify(header.slice(7));
    if (!claims) return context.json({ error: 'unauthorized' }, 401);
    // The scope name comes from the platform's identifier table, so a rename there
    // reaches the fixture too rather than leaving it quietly out of step.
    if (!claims.scope.split(' ').includes(CALENDAR_READ)) return context.json({ error: 'forbidden' }, 403);
    return context.json({ events: STUB_EVENTS });
  });

  return app;

  function verify(token: string): { sub: string; scope: string } | null {
    const [claims, signature] = token.split('.');
    if (!claims || !signature) return null;
    if (createHmac('sha256', signingSecret).update(claims).digest('base64url') !== signature) return null;
    try {
      const payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { sub: string; scope: string; exp: number };
      if (payload.exp * 1000 <= now()) return null;
      return payload;
    } catch { return null; }
  }
}

export default createApp;
