import { describe, expect, it } from 'vitest';
import { authorize, basicAuth, decodeJwtPayload } from '../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../harness/human-idp.js';

describe('agent-platform is the only XAA client', () => {
  it('returns an ID Token for agent-platform together with a refresh token', async () => {
    const idp = await startHumanIdp();
    const result = await authorize({
      fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
      scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
    });
    expect(result.error).toBeUndefined();

    const response = await idp.fetch('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth('agent-platform', 'agent-platform-secret') },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: result.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
        code_verifier: result.pkce.verifier, client_id: 'agent-platform',
      }).toString(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id_token: string; refresh_token?: string };
    expect(decodeJwtPayload(body.id_token).aud).toBe('agent-platform');
    expect(body.refresh_token).toBeDefined();
  });

  it('rejects an operation scope for agent-platform', async () => {
    const idp = await startHumanIdp();
    const result = await authorize({
      fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
      scope: 'openid workdef:submit', issuer: HUMAN_IDP_ISSUER,
    });
    expect(result.error).toBe('invalid_scope');
    expect(result.errorDescription ?? '').not.toContain('workdef:submit');
  });

  it('rejects an audience parameter for agent-platform', async () => {
    const idp = await startHumanIdp();
    const result = await authorize({
      fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
      scope: 'openid', issuer: HUMAN_IDP_ISSUER, audience: 'agent-provisioner',
    });
    expect(result.error).toBe('invalid_target');
  });
});
