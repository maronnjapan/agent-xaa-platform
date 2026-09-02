import { describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { LOGIN_SCOPE, buildAuthorizationRequest } from '../src/auth/oidc-login.js';
import {
  SESSION_COOKIE, SESSION_FIELDS, SESSION_TOKEN_AUDIENCES, createSessionStore, readSessionCookie,
} from '../src/auth/session-store.js';
import { loadConfig } from '../src/config.js';
import { ISSUER, config, mintAccessToken, startAutomationApp } from './helpers.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;

describe('the session record', () => {
  it('has exactly the seven documented fields', async () => {
    const harness = await startAutomationApp();
    expect(Object.keys(harness.session).sort()).toEqual([...SESSION_FIELDS].sort());
  });

  it('holds a token for each audience it needs and nothing else', async () => {
    const harness = await startAutomationApp();
    expect(Object.keys(harness.session.access_tokens).sort()).toEqual([...SESSION_TOKEN_AUDIENCES].sort());
    expect(Object.keys(harness.session.access_tokens)).not.toContain('agent-platform');
  });

  it('has no field a refresh token could occupy', async () => {
    const harness = await startAutomationApp();
    const serialized = JSON.stringify(harness.session);
    expect(serialized).not.toContain('refresh_token');
    // The type has no such property: assigning one is a compile error, which is what
    // the source check below enforces for the rest of the app.
    expect(() => execFileSync('bash', ['scripts/checks/no-offline-access-in-automation-app.sh'], { cwd: repoRoot })).not.toThrow();
  });

  /**
   * The compiler is what keeps the refresh token out, not a convention. This runs the
   * type checker over a session literal that carries one: a green `tsc` here would mean
   * `Session` had grown somewhere for it to live.
   */
  it('fails to compile a session that carries a refresh token', async () => {
    const project = new URL('./type-fixtures/tsconfig.json', import.meta.url).pathname;
    const failure = await promisify(execFile)('npx', ['tsc', '--noEmit', '-p', project], { cwd: repoRoot })
      .then(() => null, (error: { code?: number; stdout?: string }) => error);
    expect(failure).not.toBeNull();
    expect(failure!.code).not.toBe(0);
    expect(failure!.stdout).toContain('session-refresh-token.ts');
    expect(failure!.stdout).toContain('refresh_token');
  }, 60_000);

  it('round-trips through the store and can be destroyed', async () => {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'automation-app');
    const sessions = createSessionStore(documents);
    const created = await sessions.create({
      human_subject: 'testuser', id_token: 'x',
      access_tokens: {
        'automation-app': 'a', 'authorization-platform': 'b', 'agent-provisioner': 'c', 'lifecycle-manager': 'd',
      },
      dpop_private_jwk: { kty: 'EC' },
    });
    expect(await sessions.find(created.session_id)).toMatchObject({ human_subject: 'testuser' });
    await sessions.destroy(created.session_id);
    expect(await sessions.find(created.session_id)).toBeUndefined();
  });

  it('reads its cookie out of a header with several cookies', () => {
    expect(readSessionCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`)).toBe('abc');
    expect(readSessionCookie('a=1')).toBeUndefined();
    expect(readSessionCookie(undefined)).toBeUndefined();
  });
});

describe('logging in', () => {
  it('asks for openid profile and never offline_access', async () => {
    const request = await buildAuthorizationRequest({ issuer: ISSUER, clientId: 'automation-app', redirectUri: 'https://app.test/callback' });
    expect(LOGIN_SCOPE).toBe('openid profile');
    expect(new URL(request.url).searchParams.get('scope')).toBe('openid profile');
    expect(request.url).not.toContain('offline_access');
    expect(new URL(request.url).searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('resolving who is asking', () => {
  it('rejects typ other than at+jwt', async () => {
    const harness = await startAutomationApp({ tokenTyp: 'JWT' });
    expect((await harness.fetch('/api/activity/tasks')).status).toBe(401);
  });

  it('accepts at+jwt', async () => {
    const harness = await startAutomationApp();
    expect((await harness.fetch('/api/activity/tasks')).status).toBe(200);
  });

  it('matches the audience element-wise, not by prefix', async () => {
    for (const audience of ['automation-app-staging', 'automation', ['other-app']]) {
      const harness = await startAutomationApp({ tokenAudience: audience });
      expect((await harness.fetch('/api/activity/tasks')).status).toBe(401);
    }
    const listed = await startAutomationApp({ tokenAudience: ['other-app', 'automation-app'] });
    expect((await listed.fetch('/api/activity/tasks')).status).toBe(200);
  });

  it('rejects a request with no session', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/api/activity/tasks', { headers: { cookie: '' } });
    expect(response.status).toBe(401);
  });

  it('rejects a token whose signature does not verify', async () => {
    const harness = await startAutomationApp({ verifyAccessToken: async () => { throw new Error('bad signature'); } });
    expect((await harness.fetch('/api/activity/tasks')).status).toBe(401);
  });

  /**
   * REQ-11-038. A token may say whatever it likes about roles; the answer is the same.
   * The timeline is scoped by `sub` and nothing else, so there is no claim an operator
   * could add to widen it — which is why no cross-user view exists to be misused.
   */
  it('reads no role or group claim', async () => {
    const shared = createFirestoreDouble();
    const owner = await startAutomationApp({ shared, subject: 'user-A' });
    await owner.documents.set('user_activity', 'ev-1', {
      event_id: 'ev-1', trace_id: 'tr-1', human_subject: 'user-A', agent_id: null, task_id: 'task-1',
      occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success',
      title: 'x', message: 'y', detail: { event_type: 'TASK_COMPLETED' }, related_finding_id: null,
      is_simulated: false, expire_at: '2026-01-08T00:00:00.000Z',
    });

    const plain = await startAutomationApp({ shared, subject: 'user-B' });
    const claiming = await startAutomationApp({
      shared, subject: 'user-B', tokenClaims: { role: 'admin', groups: ['admins'], admin: true },
    });
    const asPlain = await (await plain.fetch('/api/activity/tasks')).json();
    const asAdmin = await (await claiming.fetch('/api/activity/tasks')).json();
    expect(asAdmin).toEqual(asPlain);
    expect(asAdmin).toEqual({ tasks: [] });
    expect((await claiming.fetch('/api/activity/tasks/task-1')).status).toBe(404);

    expect(await mintAccessToken({ extra: { role: 'admin' } })).toBeTruthy();
    expect(() => execFileSync('bash', ['scripts/checks/no-cross-user-route.sh'], { cwd: repoRoot })).not.toThrow();
  });
});

describe('the app shell', () => {
  it('answers healthz without a session', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/healthz', { headers: { cookie: '' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', app: 'automation-app' });
  });

  it('loads exactly the fourteen documented variables', () => {
    const loaded = loadConfig({
      ISSUER: config.issuer,
      CLIENT_SECRET_AUTOMATION_APP: config.clientSecret,
      PUBLIC_BASE_URL: config.publicBaseUrl,
      AUTHORIZATION_PLATFORM_URL: config.authorizationPlatformUrl,
      AGENT_PROVISIONER_URL: config.agentProvisionerUrl,
      LIFECYCLE_MANAGER_URL: config.lifecycleManagerUrl,
      DOCS_API_URL: config.docsApiUrl,
      ACTIVITY_TOPIC: config.activityTopic,
      VERTEX_MODEL: config.vertexModel,
    });
    expect(Object.keys(loaded)).toHaveLength(14);
    expect(loaded.clientId).toBe('automation-app');
    expect(loaded.defaultAgentLifetimeHours).toBe(1);
    expect(() => loadConfig({})).toThrow(/ISSUER is required/);
  });
});
