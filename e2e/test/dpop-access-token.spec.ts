import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint } from '@xaa/crypto';
import { authorize, basicAuth, decodeJwtPayload, tokenRequest } from '../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../harness/human-idp.js';

async function grant(idp: Awaited<ReturnType<typeof startHumanIdp>>, scope = 'openid agent:provision') {
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope, issuer: HUMAN_IDP_ISSUER,
  });
  expect(result.code).toBeDefined();
  return {
    grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
    code_verifier: result.pkce.verifier, client_id: 'automation-app',
  };
}

describe('DPoP bound access tokens', () => {
  it('binds cnf.jkt to the proof key and answers with token_type DPoP', async () => {
    const idp = await startHumanIdp();
    const keyPair = await generateEs256KeyPair();
    const response = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
      dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) }, form: await grant(idp),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { access_token: string; token_type: string };
    expect(body.token_type).toBe('DPoP');
    expect((decodeJwtPayload(body.access_token).cnf as { jkt: string }).jkt).toBe(await jwkThumbprint(keyPair.publicJwk));
  });

  it('returns 400 invalid_dpop_proof when the header is missing', async () => {
    const idp = await startHumanIdp();
    const response = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret',
      issuer: HUMAN_IDP_ISSUER, form: await grant(idp),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('rejects a replayed jti', async () => {
    const idp = await startHumanIdp();
    const keyPair = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'POST', url: `${HUMAN_IDP_ISSUER}/token`, keyPair });
    const first = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret',
      issuer: HUMAN_IDP_ISSUER, rawProof: proof, form: await grant(idp),
    });
    expect(first.status).toBe(200);
    const second = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret',
      issuer: HUMAN_IDP_ISSUER, rawProof: proof, form: await grant(idp),
    });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('echoes cnf.jkt from introspection', async () => {
    const idp = await startHumanIdp();
    const keyPair = await generateEs256KeyPair();
    const response = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
      dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) }, form: await grant(idp),
    });
    const body = await response.json() as { access_token: string };
    const introspection = await idp.fetch('/introspect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth('automation-app', 'automation-secret') },
      body: new URLSearchParams({ token: body.access_token }).toString(),
    });
    const introspected = await introspection.json() as { active: boolean; cnf?: { jkt: string } };
    expect(introspected.active).toBe(true);
    expect(introspected.cnf?.jkt).toBe((decodeJwtPayload(body.access_token).cnf as { jkt: string }).jkt);
  });

  it('returns 400 invalid_dpop_proof with DPOP_REQUIRED=true and no header', async () => {
    // DPOP_REQUIRED is the blanket flag on top of the three Control Plane audiences,
    // so this grant asks for no operation scope and still has to carry a proof.
    const idp = await startHumanIdp({ dpopRequired: true });
    const response = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret',
      issuer: HUMAN_IDP_ISSUER, form: await grant(idp, 'openid'),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('leaves a non Control Plane audience on Bearer when no proof is sent', async () => {
    const idp = await startHumanIdp();
    const response = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret',
      issuer: HUMAN_IDP_ISSUER, form: await grant(idp, 'openid'),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { token_type: string }).token_type).toBe('Bearer');
  });
});
