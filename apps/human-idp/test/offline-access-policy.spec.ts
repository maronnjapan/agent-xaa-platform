import { describe, expect, it } from 'vitest';
import type { ClientInfo } from '@maronn-openid-connect/core';
import { createOfflineAccessPolicy } from '../src/auth/offline-access-policy.js';

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

  it('refuses a client that is not registered for the refresh_token grant', async () => {
    await expect(policy(true).forCookie(cookie)(params, { promptValues: ['consent'], client: noRefresh })).resolves.toBe(false);
  });
});
