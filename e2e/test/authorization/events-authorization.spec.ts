import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, type Es256KeyPair } from '@xaa/crypto';
import { activityEventSchema, compile } from '@xaa/contracts';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { AUTHZ_BASE, startAuthorization } from '../../harness/authorization.js';

let idpJwk: JsonWebKey;
beforeAll(async () => { idpJwk = await idpPublicJwk(); });

const assertActivityEvent: (value: unknown) => asserts value is unknown = compile(activityEventSchema);

async function decide() {
  const authz = await startAuthorization({
    idpPublicJwk: idpJwk,
    humanPermissions: ['document.read', 'document.write'],
    model: {
      operations: ['read_documents', 'write_document'],
      targetResources: ['document'],
      capabilities: ['document.read', 'document.write'],
    },
  });
  const idp = await startHumanIdp();
  const keyPair: Es256KeyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope: 'openid workdef:submit', issuer: HUMAN_IDP_ISSUER,
  });
  const tokenResponse = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  const token = (await tokenResponse.json() as { access_token: string }).access_token;

  const path = '/v1/authorization/decisions';
  const response = await authz.fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `DPoP ${token}`,
      DPoP: await createDpopProof({ method: 'POST', url: `${AUTHZ_BASE}${path}`, keyPair, accessToken: token }),
    },
    body: JSON.stringify({ purpose: '書類整理', description: '書類を読んで整理する', requested_lifetime_hours: 8 }),
  });
  expect(response.status).toBe(200);
  return { authz, body: await response.json() as { decision_id: string } };
}

/**
 * REQ-11-009. One decision produces two events, in the order the person reads them:
 * what the agent may do, then how isolated it will be. Both go through the shared
 * Activity Event schema — a subscriber that receives one it cannot validate drops it,
 * and the timeline silently loses the authorization step.
 */
describe('the authorization step on the timeline', () => {
  it('emits CAPABILITY_DECIDED then ISOLATION_DECIDED, both schema-valid', async () => {
    const { authz, body } = await decide();

    const types = authz.activity.map((event) => (event.detail as { event_type?: string } | undefined)?.event_type);
    expect(types).toEqual(['CAPABILITY_DECIDED', 'ISOLATION_DECIDED']);
    for (const event of authz.activity) {
      expect(() => assertActivityEvent(event)).not.toThrow();
      expect(event.phase).toBe('authorization');
      expect(event.human_subject).toBe('testuser');
      expect(event.trace_id).toContain(body.decision_id);
    }
  });

  it('says what was denied, not only what was allowed', async () => {
    const { authz } = await decide();
    const capability = authz.activity[0]!;
    const detail = capability.detail as { allowed: string[]; denied: unknown[] };
    expect(detail.allowed).toEqual(['document.read', 'document.write']);
    expect(Array.isArray(detail.denied)).toBe(true);
  });
});
