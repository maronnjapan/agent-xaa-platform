import { describe, expect, it } from 'vitest';
import { authorize, basicAuth, tokenRequest } from '../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../harness/human-idp.js';

const CLIENT = { clientId: 'agent-platform', clientSecret: 'agent-platform-secret' };

async function connection(idp: Awaited<ReturnType<typeof startHumanIdp>>, cookie?: string) {
  const result = await authorize({
    fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER,
    ...(cookie ? { cookie, prompt: 'none' } : { prompt: 'consent' }),
  });
  expect(result.code).toBeDefined();
  const response = await tokenRequest({
    fetch: idp.fetch, ...CLIENT, issuer: HUMAN_IDP_ISSUER,
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
      code_verifier: result.pkce.verifier, client_id: 'agent-platform',
    },
  });
  expect(response.status).toBe(200);
  return { cookie: result.cookie, tokens: await response.json() as { refresh_token: string } };
}

describe('revoke touches one agent only', () => {
  it('leaves the other agent connection and the SSO session working', async () => {
    const idp = await startHumanIdp();
    const agentA = await connection(idp);
    const agentB = await connection(idp, agentA.cookie);
    expect(agentB.tokens.refresh_token).toBeDefined();

    const revoke = await idp.fetch('/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth(CLIENT.clientId, CLIENT.clientSecret) },
      body: new URLSearchParams({ token: agentA.tokens.refresh_token, token_type_hint: 'refresh_token' }).toString(),
    });
    expect(revoke.status).toBe(200);

    // Agent OP re-acquires agent B's subject_token exactly this way (DEC-ID-19): a
    // refresh grant as client_id=agent-platform, whose id_token is that subject_token.
    const refreshB = await tokenRequest({
      fetch: idp.fetch, ...CLIENT, issuer: HUMAN_IDP_ISSUER,
      form: { grant_type: 'refresh_token', refresh_token: agentB.tokens.refresh_token, client_id: 'agent-platform' },
    });
    expect(refreshB.status).toBe(200);
    expect((await refreshB.json() as { id_token?: string }).id_token).toBeDefined();

    // The browser session survives: a further /authorize with prompt=none does not
    // bounce the human back to a login screen.
    const silent = await authorize({
      fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
      scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'none', cookie: agentA.cookie,
    });
    expect(silent.error).toBeUndefined();
    expect(silent.code).toBeDefined();
  });

  it('refuses to revoke a token issued to another client', async () => {
    const idp = await startHumanIdp();
    const agentA = await connection(idp);
    const response = await idp.fetch('/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth('automation-app', 'automation-secret') },
      body: new URLSearchParams({ token: agentA.tokens.refresh_token, token_type_hint: 'refresh_token' }).toString(),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });
});
