import { describe, expect, it, vi } from 'vitest';
import { authorize, basicAuth, tokenRequest } from '../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../harness/human-idp.js';

const CLIENT = { clientId: 'agent-platform', clientSecret: 'agent-platform-secret' };

async function firstGrant(idp: Awaited<ReturnType<typeof startHumanIdp>>) {
  const result = await authorize({
    fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, ...CLIENT, issuer: HUMAN_IDP_ISSUER,
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
      code_verifier: result.pkce.verifier, client_id: 'agent-platform',
    },
  });
  expect(response.status).toBe(200);
  return { cookie: result.cookie, body: await response.json() as { access_token: string; refresh_token: string } };
}

const refresh = (idp: Awaited<ReturnType<typeof startHumanIdp>>, token: string) => tokenRequest({
  fetch: idp.fetch, ...CLIENT, issuer: HUMAN_IDP_ISSUER,
  form: { grant_type: 'refresh_token', refresh_token: token, client_id: 'agent-platform' },
});

describe('refresh token reuse revokes the grant', () => {
  it('invalidates both the replayed and the rotated token, and the access token with them', async () => {
    const idp = await startHumanIdp();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    let first: Awaited<ReturnType<typeof firstGrant>>;
    let rotated: { refresh_token: string; access_token: string };
    try {
      first = await firstGrant(idp);
      const rotation = await refresh(idp, first.body.refresh_token);
      expect(rotation.status).toBe(200);
      rotated = await rotation.json() as { refresh_token: string; access_token: string };

      const replay = await refresh(idp, first.body.refresh_token);
      expect(replay.status).toBe(400);
      expect((await replay.json() as { error: string }).error).toBe('invalid_grant');

      const afterReuse = await refresh(idp, rotated.refresh_token);
      expect(afterReuse.status).toBe(400);
      expect((await afterReuse.json() as { error: string }).error).toBe('invalid_grant');
    } finally { spy.mockRestore(); }

    const introspection = await idp.fetch('/introspect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth(CLIENT.clientId, CLIENT.clientSecret) },
      body: new URLSearchParams({ token: rotated!.access_token }).toString(),
    });
    expect((await introspection.json() as { active: boolean }).active).toBe(false);

    const reuseLines = lines.filter((line) => line.includes('"event_type":"refresh_token_reuse"'));
    expect(reuseLines).toHaveLength(1);
    expect(reuseLines[0]).not.toContain(first!.body.refresh_token);
    expect(reuseLines[0]).not.toContain(rotated!.refresh_token);
  });
});
