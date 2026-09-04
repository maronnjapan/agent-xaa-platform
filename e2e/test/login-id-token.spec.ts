import { describe, expect, it } from 'vitest';
import { buildAuthorizationRequest } from '@xaa/automation-app/src/auth/oidc-login';
import { authorize, basicAuth, decodeJwtPayload } from '../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../harness/human-idp.js';

describe('login produces an ID Token addressed to automation-app', () => {
  it('accepts the Automation App login request at the Human IdP boundary', async () => {
    const idp = await startHumanIdp();
    const request = await buildAuthorizationRequest({
      issuer: HUMAN_IDP_ISSUER,
      clientId: 'automation-app',
      redirectUri: AUTOMATION_REDIRECT_URI,
    });

    const response = await idp.fetch(request.url, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('aud is the string "automation-app"', async () => {
    const idp = await startHumanIdp();
    const result = await authorize({
      fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
      scope: 'openid', issuer: HUMAN_IDP_ISSUER,
    });
    expect(result.error).toBeUndefined();
    expect(result.code).toBeDefined();

    const response = await idp.fetch('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth('automation-app', 'automation-secret') },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
        code_verifier: result.pkce.verifier, client_id: 'automation-app',
      }).toString(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id_token: string; access_token: string };
    expect(decodeJwtPayload(body.id_token).aud).toBe('automation-app');
  });

  it('rejects an unknown client without redirecting', async () => {
    const idp = await startHumanIdp();
    const response = await idp.fetch('/authorize?response_type=code&client_id=example-client&redirect_uri=https%3A%2F%2Fautomation-app.test%2Fcallback&scope=openid&state=s&code_challenge=x&code_challenge_method=S256', { redirect: 'manual' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('location')).toBeNull();
  });
});
