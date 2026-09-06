import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair } from '@xaa/crypto';
import { buildAuthorizationRequest } from '@xaa/automation-app/src/auth/oidc-login';
import { CONSENT_SCOPE } from '@xaa/automation-app/src/auth/login-flow';
import { authorize, basicAuth, createPkce, decodeJwtPayload } from '../harness/oauth-flow.js';
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

    // With the proof the Automation App's own login flow sends: `automation-app` is a
    // Control Plane client, so DPOP_REQUIRED binds it (apps/automation-app/src/auth/
    // login-flow.ts). Exchanging without one here would test a login the app never does.
    const keyPair = await generateEs256KeyPair();
    const response = await idp.fetch('/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicAuth('automation-app', 'automation-secret'),
        DPoP: await createDpopProof({ method: 'POST', url: `${HUMAN_IDP_ISSUER}/token`, keyPair }),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
        code_verifier: result.pkce.verifier, client_id: 'automation-app',
      }).toString(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { id_token: string; access_token: string };
    expect(decodeJwtPayload(body.id_token).aud).toBe('automation-app');
  });

  /**
   * The login makes five authorization requests, but asks the person once.
   *
   * The first names every scope the four Access Tokens will need, so the consent
   * screen states the whole delegation; the four that follow name one operation scope
   * each, find that consent on record and come straight back with a code. Before this
   * the consent screen appeared five times, one scope at a time.
   */
  it('asks for every scope once, then collects each token without asking again', async () => {
    const idp = await startHumanIdp();
    const consent = await authorize({
      fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
      scope: CONSENT_SCOPE, issuer: HUMAN_IDP_ISSUER,
    });
    expect(consent.error).toBeUndefined();
    expect(consent.code).toBeDefined();

    for (const scope of ['agent:operate', 'workdef:submit', 'agent:provision', 'agent:revoke']) {
      const pkce = createPkce();
      const query = new URLSearchParams({
        response_type: 'code', client_id: 'automation-app', redirect_uri: AUTOMATION_REDIRECT_URI,
        scope: `openid ${scope}`, state: scope,
        code_challenge: pkce.challenge, code_challenge_method: 'S256',
      });
      const response = await idp.fetch(`/authorize?${query.toString()}`, {
        headers: { cookie: consent.cookie }, redirect: 'manual',
      });
      const location = response.headers.get('location') ?? '';
      // Straight back to the app, not to /consent and not to /login.
      expect(location.startsWith(AUTOMATION_REDIRECT_URI)).toBe(true);
      expect(new URL(location).searchParams.get('code')).toBeTruthy();
    }
  });

  it('rejects an unknown client without redirecting', async () => {
    const idp = await startHumanIdp();
    const response = await idp.fetch('/authorize?response_type=code&client_id=example-client&redirect_uri=https%3A%2F%2Fautomation-app.test%2Fcallback&scope=openid&state=s&code_challenge=x&code_challenge_method=S256', { redirect: 'manual' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('location')).toBeNull();
  });
});
