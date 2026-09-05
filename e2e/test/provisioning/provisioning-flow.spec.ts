import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { audienceIncludes } from '@xaa/contracts';
import { loadToolManifest } from '@xaa/agent-runtime/src/manifest/load';
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
        constraints: { external_message_send: false }, requested_lifetime_minutes: 60,
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
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_minutes: 60 },
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
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_minutes: 60, isolation_level: 'standard' },
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
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_minutes: 60 },
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
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_minutes: 60 },
    });
    const body = await response.json() as { status: string; transaction_id: string };
    expect(body.status).toBe('IDP_CONSENT_REQUIRED');
    // Nothing runs while consent is outstanding.
    expect(provisioner.jobRuns).toHaveLength(0);

    // Where the person is sent back to, and with what, is asserted against the Agent
    // OP's own redirect in `consent-resume.spec.ts`. Building the URL here and then
    // checking its parameters would only test this test.
    expect(body.transaction_id).toMatch(/^txn_/);
  });
});

/**
 * REQ-04-012 / REQ-04-013. The three sets an agent is given, and the manifest it is
 * given them for, have to describe the same reach.
 *
 * The Agent OP checks a request against the registration's audiences, resources and
 * scopes; the Runtime calls what the manifest lists. If those two disagree, the agent
 * either holds authority it cannot use or attempts calls the OP will refuse — and both
 * failures appear only at the first tool call, long after provisioning said it worked.
 * They are built once from one resolution, and this is where that is checked.
 */
describe('what the execution is handed', () => {
  it('gives the Runtime a manifest it can restore, matching the registration exactly', async () => {
    const provisionerToken = await boundToken({ audience: 'agent-provisioner', scope: 'openid agent:provision' });
    const provisioner = await createProvisionerHarness({ idpPublicJwk: await idpPublicJwk() });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read', 'document.write'] });
    const response = await send({
      fetch: provisioner.fetch, base: PROVISIONER_BASE, path: '/provisioning',
      token: provisionerToken.token, keyPair: provisionerToken.keyPair,
      body: { decision_id: decisionId, task_id: 'task-1', requested_lifetime_minutes: 60 },
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { agent_id: string; allowed_tools: string[] };

    const environment = Object.fromEntries(provisioner.jobRuns[0]!.env.map((entry) => [entry.name, entry.value]));
    // Loaded through the Runtime's own loader, digest check included: what the
    // Provisioner put on the execution is what the Runtime will accept, or this throws.
    const manifest = loadToolManifest({
      TOOL_MANIFEST: environment.TOOL_MANIFEST!, TOOL_MANIFEST_SHA256: environment.TOOL_MANIFEST_SHA256!,
    });
    expect(manifest.agent_id).toBe(created.agent_id);
    expect(manifest.tools.map((tool) => tool.tool_id)).toEqual(created.allowed_tools);

    const registration = (await provisioner.documents.get<{
      allowed_audiences: string[]; resources: string[]; scopes: string[]; expires_at: string;
    }>('agents', `${created.agent_id}__meta`))!;
    const unique = (values: string[]) => [...new Set(values)].sort();
    expect(registration.allowed_audiences).toEqual(unique(manifest.tools.map((tool) => tool.authorization.audience)));
    expect(registration.resources).toEqual(unique(manifest.tools.map((tool) => tool.authorization.resource)));
    expect(registration.scopes).toEqual(unique(manifest.tools.map((tool) => tool.authorization.scope)));
    expect(manifest.expires_at).toBe(registration.expires_at);
    // The four document tools, and a read-only agent would get two of them: the scopes
    // follow the tools rather than the capability names.
    expect(registration.scopes).toEqual(['docs.read', 'docs.write']);
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
    expect(automation.upstream.at(-1)!.url).toBe(`https://lifecycle.test/agents/${agentId}/revoke`);
  });
});
