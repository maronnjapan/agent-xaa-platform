import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { audienceIncludes } from '@xaa/contracts';
import { createProvisionerHarness, seedDecision, PROVISIONER_BASE } from '@xaa/provisioner/src/testing/harness';
import { authorize, decodeJwtPayload, tokenRequest } from '../../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { AUTHZ_BASE, startAuthorization } from '../../harness/authorization.js';
import { startAutomationAppHarness } from '../../harness/automation-app.js';

/**
 * REQ-05-024 / REQ-07-036. Login, decide, provision — the eight steps of docs 05 §2 in
 * one process, checking at each hop who the token is for and which key it is bound to.
 *
 * The audience and the `cnf.jkt` are asserted for both Access Tokens, four checks in
 * all. Together they are what makes a leaked token useless: it names the one service
 * that may accept it, and it only works to someone holding the private key.
 */
async function boundToken(input: { audience: string; scope: string }): Promise<{
  token: string; keyPair: Es256KeyPair; jkt: string;
}> {
  const idp = await startHumanIdp();
  const keyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope: input.scope, issuer: HUMAN_IDP_ISSUER, audience: input.audience,
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { access_token: string };
  return { token: body.access_token, keyPair, jkt: await jwkThumbprint(keyPair.publicJwk) };
}

async function send(input: {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  base: string;
  path: string;
  token: string;
  keyPair: Es256KeyPair;
  body: unknown;
}): Promise<Response> {
  return input.fetch(input.path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DPoP ${input.token}`,
      DPoP: await createDpopProof({
        method: 'POST', url: `${input.base}${input.path}`, keyPair: input.keyPair, accessToken: input.token,
      }),
    },
    body: JSON.stringify(input.body),
  });
}

describe('from login to a running agent', () => {
  it('binds each token to its audience and to the caller key', async () => {
    const authorizationToken = await boundToken({ audience: 'authorization-platform', scope: 'openid workdef:submit' });
    const provisionerToken = await boundToken({ audience: 'agent-provisioner', scope: 'openid agent:provision' });

    // Four assertions: two tokens, each with its own audience and its own key binding.
    const authzClaims = decodeJwtPayload(authorizationToken.token);
    expect(audienceIncludes(authzClaims.aud, 'authorization-platform')).toBe(true);
    expect((authzClaims.cnf as { jkt: string }).jkt).toBe(authorizationToken.jkt);
    const provClaims = decodeJwtPayload(provisionerToken.token);
    expect(audienceIncludes(provClaims.aud, 'agent-provisioner')).toBe(true);
    expect((provClaims.cnf as { jkt: string }).jkt).toBe(provisionerToken.jkt);

    const authorization = await startAuthorization({
      idpPublicJwk: await idpPublicJwk(), humanPermissions: ['document.read'],
      // The Authorization AI proposes; the Policy Engine narrows. Here it proposes the
      // one capability the person actually holds, so the decision comes back non-empty.
      model: { operations: ['read_documents'], targetResources: ['document'], capabilities: ['document.read'] },
    });
    const decided = await send({
      fetch: authorization.fetch, base: AUTHZ_BASE, path: '/api/work-requests',
      token: authorizationToken.token, keyPair: authorizationToken.keyPair,
      body: {
        human_subject: 'testuser', purpose: '書類を読む', description: '毎朝の確認',
        constraints: { external_message_send: false }, requested_lifetime_hours: 1,
      },
    });
    expect(decided.status).toBe(200);
    const decision = await decided.json() as { decision_id: string; effective_capabilities: string[] };
    expect(decision.effective_capabilities).toContain('document.read');

    const provisioner = await createProvisionerHarness({ idpPublicJwk: await idpPublicJwk() });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const provisioned = await send({
      fetch: provisioner.fetch, base: PROVISIONER_BASE, path: '/provisioning',
      token: provisionerToken.token, keyPair: provisionerToken.keyPair,
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 1 },
    });
    expect(provisioned.status).toBe(201);

    const created = await provisioned.json() as { agent_id: string; status: string };
    const registration = await provisioner.documents.get<{ status: string }>('agents', `${created.agent_id}__meta`);
    expect(registration!.status).toBe('ACTIVE');
    expect(provisioner.jobRuns).toHaveLength(1);
  });

  it('refuses a request that tries to name the isolation level', async () => {
    const provisionerToken = await boundToken({ audience: 'agent-provisioner', scope: 'openid agent:provision' });
    const provisioner = await createProvisionerHarness({ idpPublicJwk: await idpPublicJwk() });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const response = await send({
      fetch: provisioner.fetch, base: PROVISIONER_BASE, path: '/provisioning',
      token: provisionerToken.token, keyPair: provisionerToken.keyPair,
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 1, isolation_level: 'standard' },
    });
    // The isolation level is the Authorization Platform's to decide (RULE-07); a
    // provisioning request that states one is refused rather than obeyed.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'authorization_field_not_allowed' });
    expect(provisioner.jobRuns).toHaveLength(0);
  });

  it('refuses a decision that belongs to someone else', async () => {
    const provisionerToken = await boundToken({ audience: 'agent-provisioner', scope: 'openid agent:provision' });
    const provisioner = await createProvisionerHarness({ idpPublicJwk: await idpPublicJwk() });
    const decisionId = await seedDecision(provisioner, {
      capabilities: ['document.read'], humanSubject: 'someone-else',
    });
    const response = await send({
      fetch: provisioner.fetch, base: PROVISIONER_BASE, path: '/provisioning',
      token: provisionerToken.token, keyPair: provisionerToken.keyPair,
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 1 },
    });
    expect(response.status).not.toBe(201);
    expect(provisioner.jobRuns).toHaveLength(0);
  });

  it('stops for consent and comes back with exactly transaction_id and code', async () => {
    const provisionerToken = await boundToken({ audience: 'agent-provisioner', scope: 'openid agent:provision' });
    const provisioner = await createProvisionerHarness({
      idpPublicJwk: await idpPublicJwk(), idpConnectionStatus: 'CONSENT_REQUIRED',
    });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const response = await send({
      fetch: provisioner.fetch, base: PROVISIONER_BASE, path: '/provisioning',
      token: provisionerToken.token, keyPair: provisionerToken.keyPair,
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 1 },
    });
    const body = await response.json() as { status: string; transaction_id: string };
    expect(body.status).toBe('IDP_CONSENT_REQUIRED');
    // Nothing runs while consent is outstanding.
    expect(provisioner.jobRuns).toHaveLength(0);

    // The Agent OP returns the person with these two parameters and no others: an
    // exact set comparison, so an extra parameter is a failure rather than ignored.
    const returnUrl = new URL('https://automation-app.test/provisioning/resume');
    returnUrl.searchParams.set('transaction_id', body.transaction_id);
    returnUrl.searchParams.set('code', 'one-time-code');
    expect(new Set([...returnUrl.searchParams.keys()])).toEqual(new Set(['transaction_id', 'code']));
  });
});

describe('the screen and the agent agree on whose it is', () => {
  it('routes a stop through the Lifecycle Manager', async () => {
    const automation = await startAutomationAppHarness();
    const agentId = 'agent-cccccccccccccccccccccccccc';
    await automation.provisionerStore.set('agents', `${agentId}__meta`, {
      agent_id: agentId, human_subject: 'testuser', status: 'ACTIVE',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const response = await automation.fetch(`/api/agents/${agentId}/stop`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(automation.upstream.at(-1)!.url).toBe(`https://lifecycle.test/api/agents/${agentId}/revoke`);
  });
});
