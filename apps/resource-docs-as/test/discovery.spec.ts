import { describe, expect, it } from 'vitest';
import { createTestAs } from './helpers.js';

describe('Resource AS discovery', () => {
  it('advertises no identity_chaining and keeps authorization_grant_profiles', async () => {
    const as = await createTestAs();
    const response = await as.fetch('/.well-known/openid-configuration');
    expect(response.status).toBe(200);
    const document = await response.json() as Record<string, unknown>;
    expect(document).not.toHaveProperty('identity_chaining_requested_token_types_supported');
    expect(document.authorization_grant_profiles_supported).toEqual(['urn:ietf:params:oauth:grant-profile:id-jag']);
  });

  it('refuses the token-exchange grant with unsupported_grant_type', async () => {
    const as = await createTestAs();
    const response = await as.fetch('/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: 'agent-platform' }).toString(),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('unsupported_grant_type');
  });

  it('serves healthz without authentication', async () => {
    const response = await (await createTestAs()).fetch('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('signs with an RS256 key whose kid carries the resource prefix', async () => {
    const as = await createTestAs();
    expect(as.signingKey.kid.startsWith('docs-as-')).toBe(true);
    expect(as.signingKey.publicJwk.alg).toBe('RS256');
  });
});
