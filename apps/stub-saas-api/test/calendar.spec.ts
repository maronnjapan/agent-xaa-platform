import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import createApp, { STUB_EVENTS } from '../src/index.js';

const BASE = 'https://stub-saas-api.test';

function bearer(scope: string, options: { expired?: boolean } = {}): string {
  const claims = Buffer.from(JSON.stringify({
    sub: 'stub-user-001', scope,
    exp: Math.floor(Date.now() / 1000) + (options.expired ? -60 : 3600),
  })).toString('base64url');
  return `${claims}.${createHmac('sha256', 'stub-shared-hmac-secret').update(claims).digest('base64url')}`;
}

describe('the stub SaaS calendar API', () => {
  it('answers a Bearer with calendar.read', async () => {
    const response = await createApp().fetch(new Request(`${BASE}/calendar/events`, {
      headers: { Authorization: `Bearer ${bearer('calendar.read')}` },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: STUB_EVENTS });
    expect(STUB_EVENTS).toHaveLength(3);
  });

  it('refuses a Bearer without the scope', async () => {
    const response = await createApp().fetch(new Request(`${BASE}/calendar/events`, {
      headers: { Authorization: `Bearer ${bearer('gmail.send')}` },
    }));
    expect(response.status).toBe(403);
  });

  it('refuses a request with no header at all', async () => {
    expect((await createApp().fetch(new Request(`${BASE}/calendar/events`))).status).toBe(401);
  });

  it('refuses a tampered or expired token', async () => {
    const app = createApp();
    expect((await app.fetch(new Request(`${BASE}/calendar/events`, {
      headers: { Authorization: 'Bearer forged.signature' },
    }))).status).toBe(401);
    expect((await app.fetch(new Request(`${BASE}/calendar/events`, {
      headers: { Authorization: `Bearer ${bearer('calendar.read', { expired: true })}` },
    }))).status).toBe(401);
  });

  it('asks for no DPoP proof', async () => {
    // REQ-05-023: an external SaaS accepts what it issued, presented as Bearer.
    const response = await createApp().fetch(new Request(`${BASE}/calendar/events`, {
      headers: { Authorization: `Bearer ${bearer('calendar.read')}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });
});
