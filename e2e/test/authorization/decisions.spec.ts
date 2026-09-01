import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, type Es256KeyPair } from '@xaa/crypto';
import { CAPABILITIES } from '@xaa/contracts';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { AUTHZ_BASE, startAuthorization } from '../../harness/authorization.js';
import type { FakeModel } from '@xaa/authorization/src/testing/fixtures';

let idpJwk: JsonWebKey;

/** A real Access Token for the Authorization Platform, minted by Human IdP. */
async function controlPlaneToken(scope = 'openid workdef:submit'): Promise<{ token: string; keyPair: Es256KeyPair }> {
  const idp = await startHumanIdp();
  const keyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope, issuer: HUMAN_IDP_ISSUER,
  });
  expect(result.code).toBeDefined();
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  expect(response.status).toBe(200);
  return { token: (await response.json() as { access_token: string }).access_token, keyPair };
}

beforeAll(async () => { idpJwk = await idpPublicJwk(); });

async function submit(options: {
  body: unknown;
  model?: FakeModel;
  humanPermissions?: string[];
  path?: string;
  token?: { token: string; keyPair: Es256KeyPair };
  omitProof?: boolean;
}) {
  const authz = await startAuthorization({
    idpPublicJwk: idpJwk,
    humanPermissions: options.humanPermissions ?? [...CAPABILITIES],
    ...(options.model ? { model: options.model } : {}),
  });
  const grant = options.token ?? await controlPlaneToken();
  const path = options.path ?? '/v1/authorization/decisions';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Authorization: `DPoP ${grant.token}`,
  };
  if (!options.omitProof) {
    headers.DPoP = await createDpopProof({
      method: 'POST', url: `${AUTHZ_BASE}${path}`, keyPair: grant.keyPair, accessToken: grant.token,
    });
  }
  return { authz, response: await authz.fetch(path, { method: 'POST', headers, body: JSON.stringify(options.body) }) };
}

const request = { purpose: '予定整理', description: '当日の予定を取得し日報にまとめる', requested_lifetime_hours: 8 };

describe('POST /v1/authorization/decisions', () => {
  it('answers a decision with exactly the five contract keys', async () => {
    const { response } = await submit({ body: request });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['decision_id', 'denied', 'effective_capabilities', 'security_profile', 'status']);
    expect(String(body.decision_id).startsWith('dec_')).toBe(true);
    expect(body.status).toBe('decided');
  });

  it('records the decision against the token subject, not the body', async () => {
    const { authz, response } = await submit({ body: { ...request, human_subject: 'someone-else' } });
    // The human-subject middleware refuses a body that names a different subject.
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('human_subject_mismatch');
    expect(await authz.documents.listAll('authorization_decisions')).toHaveLength(0);
  });

  it('stores the subject from the token when the body agrees', async () => {
    const { authz, response } = await submit({ body: { ...request, human_subject: 'testuser' } });
    expect(response.status).toBe(200);
    const decisions = await authz.documents.listAll<{ human_subject: string }>('authorization_decisions');
    expect(decisions[0]!.data.human_subject).toBe('testuser');
  });

  it('answers identically under /api/work-requests', async () => {
    const grant = await controlPlaneToken();
    const first = await submit({ body: request, token: grant, path: '/v1/authorization/decisions' });
    const second = await submit({ body: request, token: grant, path: '/api/work-requests' });
    const [a, b] = await Promise.all([first.response.json(), second.response.json()]) as Array<Record<string, unknown>>;
    expect(second.response.status).toBe(200);
    // Only the generated id differs; the substance is the same.
    expect({ ...a, decision_id: '' }).toEqual({ ...b, decision_id: '' });
  });

  it('refuses a body that names permissions', async () => {
    const { response } = await submit({ body: { ...request, effective_capabilities: ['finance.payment.approve'] } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('authorization_field_not_allowed');
  });

  it('refuses a request with no proof', async () => {
    const { response } = await submit({ body: request, omitProof: true });
    expect(response.status).toBe(401);
  });

  it('refuses a token without workdef:submit', async () => {
    const { response } = await submit({ body: request, token: await controlPlaneToken('openid agent:provision') });
    expect(response.status).toBeGreaterThanOrEqual(401);
  });

  it('answers no_capability_inferred when nothing survives the taxonomy', async () => {
    const { response } = await submit({ body: request, model: { capabilities: ['slack.channel.admin'] } });
    const body = await response.json() as { status: string; effective_capabilities: string[]; security_profile: { isolation_level: string } };
    expect(body.status).toBe('no_capability_inferred');
    expect(body.effective_capabilities).toEqual([]);
    expect(body.security_profile.isolation_level).toBe('standard');
  });

  it('publishes the capability and isolation events per decision', async () => {
    const { authz } = await submit({ body: request });
    expect(authz.activity.map((event) => (event.detail as { event_type: string }).event_type))
      .toEqual(['CAPABILITY_DECIDED', 'ISOLATION_DECIDED']);
  });

  it('serves healthz without a token', async () => {
    const authz = await startAuthorization({ idpPublicJwk: idpJwk, humanPermissions: [] });
    expect((await authz.fetch('/healthz')).status).toBe(200);
  });
});
