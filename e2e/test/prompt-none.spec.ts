import { describe, expect, it } from 'vitest';
import { authorize } from '../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../harness/human-idp.js';

const base = { clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI, scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER };

describe('silent re-authorization for the second and later agents', () => {
  it('shows consent once, then completes with no interaction', async () => {
    const idp = await startHumanIdp();
    const first = await authorize({ fetch: idp.fetch, ...base, prompt: 'consent' });
    expect(first.code).toBeDefined();
    expect(first.cookie).not.toBe('');

    const second = await authorize({ fetch: idp.fetch, ...base, prompt: 'none', cookie: first.cookie });
    expect(second.error).toBeUndefined();
    expect(second.code).toBeDefined();
  });

  it('answers login_required without a session cookie', async () => {
    const idp = await startHumanIdp();
    const result = await authorize({ fetch: idp.fetch, ...base, prompt: 'none' });
    expect(result.error).toBe('login_required');
  });

  it('answers interaction_required when the consent record is gone', async () => {
    const idp = await startHumanIdp();
    const first = await authorize({ fetch: idp.fetch, ...base, prompt: 'consent' });
    await idp.stores.consentStore.revoke('testuser', 'agent-platform');
    const second = await authorize({ fetch: idp.fetch, ...base, prompt: 'none', cookie: first.cookie });
    expect(second.error).toBe('interaction_required');
  });

  it('rejects prompt=none combined with prompt=login', async () => {
    const idp = await startHumanIdp();
    const result = await authorize({ fetch: idp.fetch, ...base, prompt: 'none login' });
    expect(result.error).toBe('invalid_request');
  });
});
