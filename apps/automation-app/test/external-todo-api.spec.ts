import { describe, expect, it } from 'vitest';
import { drainActivityQueueForTesting, resetActivityPublisherForTesting } from '@xaa/contracts';
import { TODO_API_SCOPE } from '../src/auth/require-bearer-token.js';
import { WORK_DEFINITION_FIELDS } from '../src/work-definition/model.js';
import { mintAccessToken, startAutomationApp, SUBJECT, type Harness } from './helpers.js';

/**
 * The door a program comes in by.
 *
 * `/external/todos` takes a Human IdP Access Token for this app and nothing else: no
 * cookie, no session. What these fix is that the token is checked the way the session
 * guard checks its own — signature, `typ`, audience, subject, scope — that every row
 * the routes touch belongs to the token's subject, and that the API can register a
 * ToDo and read the list but cannot take any of the steps that need a person's click.
 */

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function apiToken(overrides: Parameters<typeof mintAccessToken>[0] = {}): Promise<string> {
  return mintAccessToken({ audience: 'automation-app', scope: `openid ${TODO_API_SCOPE}`, ...overrides });
}

/** Without the session cookie the harness attaches to every request. */
function asClient(harness: Harness, path: string, init: RequestInit = {}): Promise<Response> {
  return harness.fetch(path, { ...init, headers: { cookie: '', ...(init.headers as Record<string, string> | undefined) } });
}

describe('registering a ToDo with a Human IdP token', () => {
  it('creates a draft for the token subject, marked as having come from the API', async () => {
    const harness = await startAutomationApp();
    resetActivityPublisherForTesting();
    const response = await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(await apiToken()),
      body: JSON.stringify({
        title: '未処理の申請書を確認する', description: '金額を確かめる', context: '経理フォルダの「未処理」',
        done_criteria: ['一覧がある'], steps: 'まず開く\nそれから読む', notes: ['承認はしない'],
        priority: 'high', due_on: '2026-01-31', requested_lifetime_minutes: 30,
      }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual([...WORK_DEFINITION_FIELDS].sort());
    expect(created).toMatchObject({
      human_subject: SUBJECT, status: 'DRAFT', source: 'api', agent_id: null,
      title: '未処理の申請書を確認する', context: '経理フォルダの「未処理」', steps: ['まず開く', 'それから読む'],
      priority: 'high', due_on: '2026-01-31', requested_lifetime_minutes: 30,
    });
    const stored = await harness.documents.get('work_definitions', String(created.work_definition_id));
    expect(stored).toMatchObject({ human_subject: SUBJECT, source: 'api' });

    // On the timeline like any other registration, and said to have come from the API.
    const [event] = drainActivityQueueForTesting();
    expect(event).toMatchObject({ human_subject: SUBJECT, phase: 'work_definition' });
    expect(event?.detail).toMatchObject({ event_type: 'PROPOSED', source: 'api', purpose: '未処理の申請書を確認する' });
  });

  it('takes the subject from the token and never from the body', async () => {
    const harness = await startAutomationApp();
    const response = await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(await apiToken({ subject: 'otheruser' })),
      body: JSON.stringify({ title: 'x', human_subject: 'testuser', status: 'CONFIRMED', agent_id: 'agent-x' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ human_subject: 'otheruser', status: 'DRAFT', agent_id: null });
  });

  it('refuses a bad body by name, and a body that is not an object', async () => {
    const harness = await startAutomationApp();
    const token = await apiToken();
    const untitled = await asClient(harness, '/external/todos', { method: 'POST', headers: bearer(token), body: JSON.stringify({}) });
    expect(untitled.status).toBe(400);
    expect(await untitled.json()).toEqual({ error: 'title_required' });
    const lifetime = await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(token), body: JSON.stringify({ title: 'x', requested_lifetime_minutes: 1441 }),
    });
    expect(await lifetime.json()).toEqual({ error: 'lifetime_out_of_range' });
    const list = await asClient(harness, '/external/todos', { method: 'POST', headers: bearer(token), body: '[1]' });
    expect(list.status).toBe(400);
    expect(await list.json()).toEqual({ error: 'invalid_request' });
    const broken = await asClient(harness, '/external/todos', { method: 'POST', headers: bearer(token), body: '{' });
    expect(broken.status).toBe(400);
  });
});

describe('what the token has to be', () => {
  it('answers 401 with a challenge when there is no token, or the scheme is not Bearer', async () => {
    const harness = await startAutomationApp();
    const none = await asClient(harness, '/external/todos', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="automation-app"');
    expect(await none.json()).toEqual({ error: 'invalid_token' });

    const dpop = await asClient(harness, '/external/todos', {
      method: 'POST', headers: { Authorization: `DPoP ${await apiToken()}` }, body: JSON.stringify({ title: 'x' }),
    });
    expect(dpop.status).toBe(401);
  });

  it('ignores the session cookie: a browser is not an API client', async () => {
    const harness = await startAutomationApp();
    // The harness's own cookie, and no Authorization header.
    const response = await harness.fetch('/external/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a token that does not verify, an ID Token, and a token for another audience', async () => {
    const harness = await startAutomationApp({ verifyAccessToken: async (token) => {
      if (token.endsWith('.forged')) throw new Error('bad signature');
      return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    } });
    const body = JSON.stringify({ title: 'x' });
    const forged = await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(`${(await apiToken()).split('.').slice(0, 2).join('.')}.forged`), body,
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get('www-authenticate')).toContain('error="invalid_token"');

    // DEC-ID-18: under one issuer an ID Token verifies just as well; `typ` is the difference.
    const idToken = await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(await apiToken({ typ: 'JWT' })), body,
    });
    expect(idToken.status).toBe(401);

    // DEV-12: the audience is matched element-wise, and a Control Plane token is not ours.
    for (const audience of ['authorization-platform', 'automation-app-staging', ['agent-provisioner']]) {
      const wrong = await asClient(harness, '/external/todos', {
        method: 'POST', headers: bearer(await apiToken({ audience })), body,
      });
      expect(wrong.status).toBe(401);
    }
    const listed = await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(await apiToken({ audience: ['authorization-platform', 'automation-app'] })), body,
    });
    expect(listed.status).toBe(201);
  });

  it('answers 403 insufficient_scope for a token without agent:operate', async () => {
    const harness = await startAutomationApp();
    const response = await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(await apiToken({ scope: 'openid workdef:submit' })), body: JSON.stringify({ title: 'x' }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(await response.json()).toEqual({ error: 'insufficient_scope' });
    expect(TODO_API_SCOPE).toBe('agent:operate');
  });
});

describe("reading the person's list", () => {
  it('lists the token subject\'s ToDos and nobody else\'s, narrowed by status when asked', async () => {
    const harness = await startAutomationApp();
    const token = await apiToken();
    const create = (title: string, subject = SUBJECT): Promise<Response> => asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(subject === SUBJECT ? token : ''), body: JSON.stringify({ title }),
    });
    const mine = await (await create('mine')).json() as { work_definition_id: string };
    await harness.documents.set('work_definitions', 'wd_theirs', {
      ...(await harness.documents.get('work_definitions', mine.work_definition_id))!,
      work_definition_id: 'wd_theirs', human_subject: 'someone-else', title: 'theirs',
    });
    await harness.fetch(`/api/todos/${mine.work_definition_id}/confirm`, { method: 'POST' });

    const all = await asClient(harness, '/external/todos', { headers: bearer(token) });
    expect(all.status).toBe(200);
    const listed = await all.json() as { todos: Array<{ title: string; status: string }> };
    expect(listed.todos.map((row) => row.title)).toEqual(['mine']);

    const confirmed = await (await asClient(harness, '/external/todos?status=CONFIRMED', { headers: bearer(token) })).json() as { todos: unknown[] };
    expect(confirmed.todos).toHaveLength(1);
    const drafts = await (await asClient(harness, '/external/todos?status=DRAFT', { headers: bearer(token) })).json() as { todos: unknown[] };
    expect(drafts.todos).toHaveLength(0);

    const one = await asClient(harness, `/external/todos/${mine.work_definition_id}`, { headers: bearer(token) });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ title: 'mine', status: 'CONFIRMED' });
    const theirs = await asClient(harness, '/external/todos/wd_theirs', { headers: bearer(token) });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: 'not_found' });
  });

  it('offers none of the steps that need a click', async () => {
    const harness = await startAutomationApp();
    const token = await apiToken();
    const created = await (await asClient(harness, '/external/todos', {
      method: 'POST', headers: bearer(token), body: JSON.stringify({ title: 'x' }),
    })).json() as { work_definition_id: string };
    for (const path of [
      `/external/todos/${created.work_definition_id}/confirm`, `/external/todos/${created.work_definition_id}/submit`,
      `/external/todos/${created.work_definition_id}/complete`, `/external/todos/${created.work_definition_id}/cancel`,
      '/external/agent-definitions/ad_1/approve', '/external/agent-definitions/ad_1/provision',
    ]) {
      expect((await asClient(harness, path, { method: 'POST', headers: bearer(token) })).status).toBe(404);
    }
    // And the token opens nothing under the session's own door.
    expect((await asClient(harness, `/api/todos/${created.work_definition_id}/confirm`, { method: 'POST', headers: bearer(token) })).status).toBe(401);
    expect((await harness.documents.get<{ status: string }>('work_definitions', created.work_definition_id))?.status).toBe('DRAFT');
  });
});
