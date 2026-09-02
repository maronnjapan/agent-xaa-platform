import { describe, expect, it, beforeEach } from 'vitest';
import {
  ACTIVITY_TOPIC, TASK_ID_PATTERN, TERMINAL_EVENTS, classifyTaskId, drainActivityQueueForTesting,
  isTerminalEvent, resetActivityPublisherForTesting, validateActivityEvent, ACTIVITY_EVENT_OUTCOMES,
  ACTIVITY_EVENT_PHASES, type ActivityEvent,
} from '@xaa/contracts';
import { buildActivityPath, decodePushMessage, storeActivityEvent } from '../src/activity/subscriber.js';
import { readTimeline } from '../src/activity/query.js';
import { emitAgentStopped, emitConfirmed, emitLoggedIn, emitProposed } from '../src/activity/emit.js';
import { AGENT_ID, ISSUER, SUBJECT, mintAccessToken, seedAgent, startAutomationApp } from './helpers.js';

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return validateActivityEvent({
    event_id: 'ev-1', trace_id: 'tr-1', human_subject: SUBJECT, agent_id: null, task_id: 'provisioning',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', phase: 'login', outcome: 'info',
    title: 'ログインしました', message: 'ログインしました。', related_finding_id: null, is_simulated: false,
    ...overrides,
  });
}

describe('the Activity Event schema', () => {
  it('rejects an eighth phase and a fourth outcome', () => {
    expect(ACTIVITY_EVENT_PHASES).toHaveLength(7);
    expect(ACTIVITY_EVENT_OUTCOMES).toHaveLength(3);
    expect(() => event({ phase: 'provisioning_extra' as never })).toThrow();
    expect(() => event({ outcome: 'denied' as never })).toThrow();
  });

  it('accepts an event with no detail and rejects an unknown key', () => {
    expect(() => event()).not.toThrow();
    expect(() => event({ scratch: 1 } as never)).toThrow();
  });

  it('names one topic', () => {
    expect(ACTIVITY_TOPIC).toBe('agent-activity-stream');
  });
});

describe('task boundaries', () => {
  it('rejects task-abc, task-0, task-01 and provisioning-1', () => {
    for (const invalid of ['task-abc', 'task-0', 'task-01', 'provisioning-1', '']) {
      expect(classifyTaskId(invalid)).toBeNull();
      expect(TASK_ID_PATTERN.test(invalid)).toBe(false);
    }
    expect(classifyTaskId('task-12')).toBe('task');
    expect(classifyTaskId('demo-dpop-replay')).toBe('demo');
  });

  it('flattens to the eight documented terminal events', () => {
    const all = Object.values(TERMINAL_EVENTS).flat();
    expect(new Set(all)).toEqual(new Set([
      'AGENT_PROVISIONED', 'TASK_COMPLETED', 'TASK_BLOCKED', 'TASK_FAILED',
      'AGENT_EXPIRED', 'AGENT_STOPPED', 'AGENT_QUARANTINED', 'AGENT_REVOKED_SECURITY',
    ]));
    expect(all).toHaveLength(8);
  });

  it('treats a demo task as always terminal', () => {
    expect(isTerminalEvent('demo-dpop-replay', 'ANYTHING')).toBe(true);
    expect(isTerminalEvent('task-1', 'AGENT_PROVISIONED')).toBe(false);
    expect(isTerminalEvent('task-1', 'TASK_BLOCKED')).toBe(true);
  });
});

describe('the four Automation App emitters', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  it('publishes one event each with the fixed phase, outcome and task', async () => {
    await emitLoggedIn({ humanSubject: SUBJECT });
    await emitProposed({ humanSubject: SUBJECT }, { purpose: '日報作成', workDefinitionId: 'wd_1' });
    await emitConfirmed({ humanSubject: SUBJECT }, { purpose: '日報作成', workDefinitionId: 'wd_1' });
    await emitAgentStopped({ humanSubject: SUBJECT }, { agentId: 'agent-abcdefghijklmnopqrstuvwxyz' });

    const events = drainActivityQueueForTesting();
    expect(events.map((entry) => [entry.phase, entry.outcome, entry.task_id])).toEqual([
      ['login', 'info', 'provisioning'],
      ['work_definition', 'info', 'provisioning'],
      ['work_definition', 'success', 'provisioning'],
      ['lifecycle', 'success', 'lifecycle'],
    ]);
    expect(events.map((entry) => (entry.detail as { event_type: string }).event_type))
      .toEqual(['LOGGED_IN', 'PROPOSED', 'CONFIRMED', 'AGENT_STOPPED']);
  });

  it('writes Japanese titles and messages, never blank', async () => {
    await emitProposed({ humanSubject: SUBJECT }, { purpose: '経費精算', workDefinitionId: 'wd_1' });
    const [entry] = drainActivityQueueForTesting();
    expect(entry!.message).toBe('Automation Design AI が「経費精算」を提案しました');
    for (const text of [entry!.title, entry!.message]) {
      expect(text.trim()).not.toBe('');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(text)).toBe(false);
    }
  });

  /**
   * The four events as the app actually produces them: a real login, a work definition
   * proposed and confirmed, and an agent stopped. Nothing calls an emitter directly, so
   * this fails if a route stops emitting — which is how these go missing.
   */
  it('publishes one event per operation, from logging in to stopping', async () => {
    // The Human IdP's answer at each of the five token exchanges the login makes.
    const plan = ['automation-app', 'authorization-platform', 'agent-provisioner', 'lifecycle-manager'];
    let pending = { stage: -1, nonce: '' };
    const harness = await startAutomationApp({
      upstreamHandler: async (url) => {
        if (!url.startsWith(`${ISSUER}/token`)) return Response.json({ status: 'revoking' }, { status: 200 });
        const audience = pending.stage < 0 ? 'automation-app' : plan[pending.stage]!;
        return Response.json({
          id_token: await mintAccessToken({ typ: 'JWT', extra: { nonce: pending.nonce } }),
          ...(pending.stage < 0 ? {} : {
            access_token: await mintAccessToken({ audience }),
            token_type: 'DPoP',
          }),
        });
      },
    });
    resetActivityPublisherForTesting();

    let response = await harness.fetch('/login', { headers: { cookie: '' } });
    let location = response.headers.get('location') ?? '';
    let cookie = '';
    for (let round = 0; round <= plan.length; round += 1) {
      const state = new URL(location).searchParams.get('state')!;
      const transaction = await harness.documents.get<{ stage: number; nonce: string }>('login_transactions', state);
      pending = { stage: transaction!.stage, nonce: transaction!.nonce };
      response = await harness.fetch(`/callback?state=${state}&code=c${round}`, { headers: { cookie: '' } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      location = response.headers.get('location') ?? '';
      if (location === '/') break;
    }
    expect(location).toBe('/');
    expect(cookie).toContain('xaa_session=');

    const asUser = (path: string, init: RequestInit = {}): Promise<Response> =>
      harness.fetch(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });

    const created = await (await asUser('/api/work-definitions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: '毎朝の日報をまとめる' }),
    })).json() as { work_definition_id: string };
    await asUser(`/api/work-definitions/${created.work_definition_id}/confirm`, { method: 'POST' });
    await seedAgent(harness, { state: { agent_status: 'ACTIVE' } });
    expect((await asUser(`/api/agents/${AGENT_ID}/stop`, { method: 'POST' })).status).toBe(200);

    const published = drainActivityQueueForTesting();
    expect(published.map((entry) => (entry.detail as { event_type: string }).event_type))
      .toEqual(['LOGGED_IN', 'PROPOSED', 'CONFIRMED', 'AGENT_STOPPED']);
    expect(published.map((entry) => [entry.phase, entry.outcome, entry.task_id])).toEqual([
      ['login', 'info', 'provisioning'],
      ['work_definition', 'info', 'provisioning'],
      ['work_definition', 'success', 'provisioning'],
      ['lifecycle', 'success', 'lifecycle'],
    ]);
    for (const entry of published) {
      expect(entry.human_subject).toBe(SUBJECT);
      for (const text of [entry.title, entry.message]) {
        expect(text.trim()).not.toBe('');
        // eslint-disable-next-line no-control-regex
        expect(/^[\x00-\x7F]*$/.test(text)).toBe(false);
      }
    }
  });

  it('rejects an empty title before it can reach the topic', async () => {
    const { publishActivityEvent } = await import('@xaa/contracts');
    await expect(publishActivityEvent(event({ title: ' ' }))).rejects.toThrow(/title/);
    await expect(publishActivityEvent(event({ message: ' ' }))).rejects.toThrow(/message/);
  });
});

const push = (harness: Awaited<ReturnType<typeof startAutomationApp>>, activity: ActivityEvent): Promise<Response> =>
  harness.fetch('/internal/activity/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer pubsub-oidc', cookie: '' },
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(activity)).toString('base64') } }),
  });

describe('the push subscriber', () => {
  it('rejects a delivery with no token', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/internal/activity/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: '' },
      body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(event())).toString('base64') } }),
    });
    expect(response.status).toBe(401);
  });

  /**
   * The endpoint as Pub/Sub reaches it: one delivery, one document, at the path docs 11
   * §3.2 names, with the seven-day expiry the TTL policy sweeps on. The OIDC check is
   * the one thing stood in for — everything after it is the real handler.
   */
  it('writes one document per delivery, at the documented path', async () => {
    const harness = await startAutomationApp({ verifyPush: async () => ({ email: 'sa-pubsub-push@x' }) });
    const delivered = event({ event_id: 'ev-push', occurred_at: '2026-03-01T00:00:00.000Z' });
    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await push(harness, delivered));
    }
    for (const response of responses) expect(response.status).toBe(200);
    expect(await responses[0]!.json()).toEqual({ status: 'created' });
    expect(await responses[1]!.json()).toEqual({ status: 'duplicate' });

    const rows = await harness.documents.queryEqual('user_activity', [['event_id', 'ev-push']]);
    expect(rows).toHaveLength(1);
    expect(buildActivityPath(SUBJECT, 'ev-push')).toBe(`users/${SUBJECT}/activity/ev-push`);
    const stored = await harness.documents.get<{ expire_at: string; title: string }>('user_activity', 'ev-push');
    expect(stored!.expire_at).toBe('2026-03-08T00:00:00.000Z');
  });

  it('refuses a body the schema does not accept, and writes nothing', async () => {
    const harness = await startAutomationApp({ verifyPush: async () => ({ email: 'sa-pubsub-push@x' }) });
    const response = await harness.fetch('/internal/activity/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: '' },
      body: JSON.stringify({
        message: { data: Buffer.from(JSON.stringify({ event_id: 'ev-bad', phase: 'nonsense' })).toString('base64') },
      }),
    });
    // 400 rather than 500: Pub/Sub redelivers a 5xx forever, and a body that fails the
    // schema will fail it every time.
    expect(response.status).toBe(400);
    expect(await harness.documents.queryEqual('user_activity', [['event_id', 'ev-bad']])).toHaveLength(0);
  });

  it('refuses a body that is not an Activity Event', () => {
    expect(() => decodePushMessage({})).toThrow();
    expect(() => decodePushMessage({ message: { data: Buffer.from('not json').toString('base64') } })).toThrow();
    expect(() => decodePushMessage({ message: { data: Buffer.from('{"a":1}').toString('base64') } })).toThrow();
  });

  it('writes once however many times the same event arrives', async () => {
    const harness = await startAutomationApp();
    const activity = event({ event_id: 'ev-dup', title: '一回目' });
    expect(await storeActivityEvent({ documents: harness.documents, event: activity })).toBe('created');
    expect(await storeActivityEvent({ documents: harness.documents, event: { ...activity, title: '二回目' } })).toBe('duplicate');
    expect(await storeActivityEvent({ documents: harness.documents, event: { ...activity, title: '三回目' } })).toBe('duplicate');
    const rows = await harness.documents.queryEqual('user_activity', [['human_subject', SUBJECT]]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ title: '一回目' });
  });

  it('sets expire_at seven days after the event', async () => {
    const harness = await startAutomationApp();
    await storeActivityEvent({ documents: harness.documents, event: event({ event_id: 'ev-ttl' }) });
    const stored = await harness.documents.get<{ expire_at: string }>('user_activity', 'ev-ttl');
    expect(stored!.expire_at).toBe('2026-01-08T00:00:00.000Z');
  });

  it('refuses a subject that would address another segment', () => {
    expect(() => buildActivityPath('user/../other', 'ev-1')).toThrow();
    expect(() => buildActivityPath('user', 'ev/1')).toThrow();
    expect(buildActivityPath('testuser', 'ev-1')).toBe('users/testuser/activity/ev-1');
  });
});

describe('reading the timeline', () => {
  async function seedTimeline(harness: Awaited<ReturnType<typeof startAutomationApp>>, events: ActivityEvent[]): Promise<void> {
    for (const entry of events) await storeActivityEvent({ documents: harness.documents, event: entry });
  }

  it('hides the events of a task that has not ended', async () => {
    const harness = await startAutomationApp();
    await seedTimeline(harness, Array.from({ length: 5 }, (_unused, index) => event({
      event_id: `ev-${index}`, task_id: 'task-1', phase: 'tool_call',
      occurred_at: `2026-01-01T00:0${index}:00.000Z`, message: `五件のうち ${index}`,
      detail: { event_type: 'TOOL_SUCCEEDED' },
    })));
    const body = await (await harness.fetch('/api/activity/tasks')).json() as { tasks: Array<Record<string, unknown>> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({ status: 'running' });
    expect(body.tasks[0]).not.toHaveProperty('events');
    expect(JSON.stringify(body)).not.toContain('五件のうち');
  });

  it('returns every event once the terminal one arrives', async () => {
    const harness = await startAutomationApp();
    await seedTimeline(harness, [
      ...Array.from({ length: 5 }, (_unused, index) => event({
        event_id: `ev-${index}`, task_id: 'task-1', phase: 'tool_call',
        occurred_at: `2026-01-01T00:0${index}:00.000Z`, detail: { event_type: 'TOOL_SUCCEEDED' },
      })),
      event({
        event_id: 'ev-final', task_id: 'task-1', phase: 'tool_call', outcome: 'success',
        occurred_at: '2026-01-01T00:06:00.000Z', detail: { event_type: 'TASK_COMPLETED' },
      }),
    ]);
    const body = await (await harness.fetch('/api/activity/tasks')).json() as {
      tasks: Array<{ status: string; events?: unknown[]; terminal_outcome?: string }>;
    };
    expect(body.tasks[0]!.status).toBe('completed');
    expect(body.tasks[0]!.events).toHaveLength(6);
    expect(body.tasks[0]!.terminal_outcome).toBe('success');
  });

  it('returns nothing of another user, however the request asks', async () => {
    const shared = (await import('@xaa/gcp')).createFirestoreDouble();
    const userA = await startAutomationApp({ shared, subject: 'user-A' });
    const userB = await startAutomationApp({ shared, subject: 'user-B' });
    await storeActivityEvent({
      documents: userB.documents,
      event: event({ event_id: 'ev-b', human_subject: 'user-B', task_id: 'task-9', detail: { event_type: 'TASK_COMPLETED' } }),
    });

    const list = await (await userA.fetch('/api/activity/tasks?human_subject=user-B')).json() as { tasks: unknown[] };
    expect(list.tasks).toEqual([]);
    expect((await userA.fetch('/api/activity/tasks/task-9')).status).toBe(404);
    expect((await userB.fetch('/api/activity/tasks/task-9')).status).toBe(200);
  });

  it('orders provisioning first and lifecycle last', async () => {
    const harness = await startAutomationApp();
    await seedTimeline(harness, [
      event({ event_id: 'ev-life', task_id: 'lifecycle', phase: 'lifecycle', outcome: 'success', occurred_at: '2026-01-01T05:00:00.000Z', detail: { event_type: 'AGENT_STOPPED' } }),
      event({ event_id: 'ev-t2', task_id: 'task-2', phase: 'tool_call', outcome: 'success', occurred_at: '2026-01-01T03:00:00.000Z', detail: { event_type: 'TASK_COMPLETED' } }),
      event({ event_id: 'ev-prov', task_id: 'provisioning', phase: 'provisioning', outcome: 'success', occurred_at: '2026-01-01T01:00:00.000Z', detail: { event_type: 'AGENT_PROVISIONED' } }),
      event({ event_id: 'ev-t1', task_id: 'task-1', phase: 'tool_call', outcome: 'success', occurred_at: '2026-01-01T04:00:00.000Z', detail: { event_type: 'TASK_COMPLETED' } }),
    ]);
    const tasks = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    // task-2 finished before task-1, so it comes first: the order is what happened.
    expect(tasks.map((task) => task.task_id)).toEqual(['provisioning', 'task-2', 'task-1', 'lifecycle']);
  });
});
