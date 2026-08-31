import { describe, expect, it } from 'vitest';
import { audienceIncludes } from '@xaa/contracts';
import { createDpopProof, generateEs256KeyPair } from '@xaa/crypto';
import { authorize, decodeJwtHeader, decodeJwtPayload, tokenRequest } from '../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../harness/human-idp.js';

async function accessTokenFor(scope: string, audience?: string) {
  const idp = await startHumanIdp();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope, issuer: HUMAN_IDP_ISSUER, ...(audience ? { audience } : {}),
  });
  if (result.error) return { error: result.error };
  const keyPair = await generateEs256KeyPair();
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  const body = await response.json() as { access_token: string; scope: string; token_type: string };
  return { payload: decodeJwtPayload(body.access_token), header: decodeJwtHeader(body.access_token), body, keyPair };
}

describe('operation scope decides the access token audience', () => {
  it('workdef:submit maps to authorization-platform and aud has two elements', async () => {
    const { payload } = await accessTokenFor('openid workdef:submit');
    expect(audienceIncludes(payload!.aud, 'authorization-platform')).toBe(true);
    expect(payload!.aud as string[]).toHaveLength(2);
  });

  it('agent:provision maps to agent-provisioner', async () => {
    const { payload } = await accessTokenFor('openid agent:provision');
    expect(audienceIncludes(payload!.aud, 'agent-provisioner')).toBe(true);
  });

  it('agent:revoke maps to lifecycle-manager and agent:operate to automation-app', async () => {
    expect(audienceIncludes((await accessTokenFor('openid agent:revoke')).payload!.aud, 'lifecycle-manager')).toBe(true);
    expect(audienceIncludes((await accessTokenFor('openid agent:operate')).payload!.aud, 'automation-app')).toBe(true);
  });

  it('two operation scopes in one request are invalid_scope', async () => {
    expect((await accessTokenFor('openid workdef:submit agent:provision')).error).toBe('invalid_scope');
  });

  it('an unregistered operation scope is invalid_scope', async () => {
    expect((await accessTokenFor('openid agent:destroy')).error).toBe('invalid_scope');
  });

  it('an audience outside the allow list is invalid_target', async () => {
    expect((await accessTokenFor('openid agent:provision', 'unknown-app')).error).toBe('invalid_target');
  });

  it('carries the requested scope and the at+jwt type', async () => {
    const { payload, header } = await accessTokenFor('openid agent:provision');
    expect(String(payload!.scope)).toContain('agent:provision');
    expect(header!.typ).toBe('at+jwt');
  });
});
