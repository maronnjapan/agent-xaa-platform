import { describe, expect, it } from 'vitest';
import type { ClientInfo } from '@maronn-openid-connect/core';
import { createOfflineAccessPolicy } from '../src/auth/offline-access-policy.js';
import { createTestApp, testEnv } from './helpers.js';

const agentPlatform = { clientId: 'agent-platform', grantTypes: ['authorization_code', 'refresh_token'] } as unknown as ClientInfo;
const automationApp = { clientId: 'automation-app', grantTypes: ['authorization_code', 'refresh_token'] } as unknown as ClientInfo;
const noRefresh = { clientId: 'agent-platform', grantTypes: ['authorization_code'] } as unknown as ClientInfo;

function policy(consented: boolean, hasSession = true) {
  return createOfflineAccessPolicy({
    consentStore: { hasConsent: async () => consented },
    browserSessionStore: { get: async () => (hasSession ? { subject: 'user-1', authTime: 0 } : undefined) },
  });
}

const params = { scope: 'openid offline_access' } as never;
const cookie = 'session_id=abc';

describe('offline_access policy', () => {
  it('grants refresh token with prompt=none when consent recorded', async () => {
    await expect(policy(true).forCookie(cookie)(params, { promptValues: ['none'], client: agentPlatform })).resolves.toBe(true);
  });

  it('returns false when no consent record exists', async () => {
    await expect(policy(false).forCookie(cookie)(params, { promptValues: ['none'], client: agentPlatform })).resolves.toBe(false);
  });

  it('returns false without a browser session', async () => {
    await expect(policy(true, false).forCookie(cookie)(params, { promptValues: ['none'], client: agentPlatform })).resolves.toBe(false);
    await expect(policy(true).forCookie(null)(params, { promptValues: ['none'], client: agentPlatform })).resolves.toBe(false);
  });

  it('never grants offline_access to automation-app under prompt=none', async () => {
    await expect(policy(true).forCookie(cookie)(params, { promptValues: ['none'], client: automationApp })).resolves.toBe(false);
  });

  it('keeps the prompt=consent path unchanged for both clients', async () => {
    await expect(policy(false).forCookie(cookie)(params, { promptValues: ['consent'], client: agentPlatform })).resolves.toBe(true);
    await expect(policy(false).forCookie(cookie)(params, { promptValues: ['consent'], client: automationApp })).resolves.toBe(true);
  });

  // The policy itself only answers yes or no. Turning "logged in but never consented"
  // into interaction_required is the authorize patch's job, so it is exercised over
  // the real route: a Provisioner must be able to tell that apart from "no session".
  it('returns interaction_required when no consent record', async () => {
    const app = await createTestApp();
    await app.stores.browserSessionStore.set('sess-1', { subject: 'testuser', authTime: Math.floor(Date.now() / 1000) });
    const query = new URLSearchParams({
      response_type: 'code', client_id: 'agent-platform', redirect_uri: testEnv.agentOpCallbackUri,
      scope: 'openid offline_access', state: 'st', prompt: 'none',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
    });
    const response = await app.fetch(`/authorize?${query.toString()}`, {
      redirect: 'manual', headers: { cookie: 'session_id=sess-1' },
    });
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('interaction_required');
    expect(location.origin + location.pathname).toBe(testEnv.agentOpCallbackUri);
  });

  it('refuses a client that is not registered for the refresh_token grant', async () => {
    await expect(policy(true).forCookie(cookie)(params, { promptValues: ['consent'], client: noRefresh })).resolves.toBe(false);
  });
});
