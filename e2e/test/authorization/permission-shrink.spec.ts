import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, type Es256KeyPair } from '@xaa/crypto';
import { createFirestoreDouble } from '@xaa/gcp';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { AUTHZ_BASE, startAuthorization, type AuthorizationHarness } from '../../harness/authorization.js';

let idpJwk: JsonWebKey;
beforeAll(async () => { idpJwk = await idpPublicJwk(); });

const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

async function controlPlaneToken(): Promise<{ token: string; keyPair: Es256KeyPair }> {
  const idp = await startHumanIdp();
  const keyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope: 'openid workdef:submit', issuer: HUMAN_IDP_ISSUER,
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  return { token: (await response.json() as { access_token: string }).access_token, keyPair };
}

/** One agent, decided for and running, as the Provisioner would have left it. */
async function runningAgent(permissions: string[]): Promise<{ authz: AuthorizationHarness; decisionId: string }> {
  const shared = createFirestoreDouble();
  const authz = await startAuthorization({
    idpPublicJwk: idpJwk, humanPermissions: permissions, shared,
    // The proposal is what re-evaluation reads back, so it has to name the capabilities
    // whose loss this test is about.
    model: {
      operations: ['read_documents', 'write_document'],
      targetResources: ['document'],
      capabilities: ['document.read', 'document.write'],
    },
  });
  const grant = await controlPlaneToken();
  const path = '/v1/authorization/decisions';
  const decided = await authz.fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `DPoP ${grant.token}`,
      DPoP: await createDpopProof({ method: 'POST', url: `${AUTHZ_BASE}${path}`, keyPair: grant.keyPair, accessToken: grant.token }),
    },
    body: JSON.stringify({ purpose: '書類整理', description: '書類を読んで整理する', requested_lifetime_hours: 8 }),
  });
  expect(decided.status).toBe(200);
  const { decision_id: decisionId } = await decided.json() as { decision_id: string };

  await authz.provisionerStore.set('agents', `${AGENT_ID}__meta`, {
    agent_id: AGENT_ID, human_subject: 'testuser', status: 'ACTIVE',
    created_at: new Date().toISOString(),
  });
  return { authz, decisionId };
}

/** The permission table is the seed Job's to write; this is what a revocation looks like. */
async function revoke(authz: AuthorizationHarness, capability: string): Promise<void> {
  await authz.seedStore.delete('human_permissions', `testuser__${capability}`);
}

async function deliver(authz: AuthorizationHarness, body: unknown): Promise<Response> {
  return authz.fetch('/internal/events/human-permission-changed', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/**
 * RULE-13 and RULE-14. An agent's authority is fixed when it is created, so a narrowing
 * cannot be applied in place — the agent is replaced — and a widening must not reach it
 * at all. The two directions are asymmetric on purpose, and this is where that shows.
 */
describe('a permission change reaches running agents', () => {
  it('asks for Re-Provisioning when the person loses a capability, with the AI untouched', async () => {
    const { authz } = await runningAgent(['document.read', 'document.write']);
    await revoke(authz, 'document.write');

    const response = await deliver(authz, {
      human_subject: 'testuser', changed_at: '2026-03-01T00:00:00.000Z',
      capability_id: 'document.write', action: 'revoke',
    });

    expect(response.status).toBe(204);
    expect(authz.reprovisions).toHaveLength(1);
    const asked = authz.reprovisions[0]!;
    expect(asked.agentId).toBe(AGENT_ID);
    // What is left of the old set, never more.
    expect(asked.effectiveCapabilities).not.toContain('document.write');
    expect(asked.effectiveCapabilities.every((capability) => capability !== 'document.write')).toBe(true);
    // The model is not asked again: the stored proposal is reused (REQ-03-022). The
    // one inference on record is the original decision, made before the change.
    const inferences = authz.logs.filter((line) => (JSON.parse(line) as { event: string }).event === 'authz_ai.infer');
    expect(inferences).toHaveLength(1);
  });

  it('leaves a running agent alone when the person gains one, and says so once', async () => {
    const { authz } = await runningAgent(['document.read']);
    await authz.seedStore.set('human_permissions', 'testuser__document.write', {
      human_subject: 'testuser', capability_id: 'document.write', granted_at: new Date().toISOString(),
    });

    const response = await deliver(authz, {
      human_subject: 'testuser', changed_at: '2026-03-02T00:00:00.000Z',
      capability_id: 'document.write', action: 'grant',
    });

    expect(response.status).toBe(204);
    expect(authz.reprovisions).toHaveLength(0);
    const ignored = authz.activity.filter((event) =>
      (event.detail as { event_type?: string } | undefined)?.event_type === 'PERMISSION_CHANGE_IGNORED');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.agent_id).toBe(AGENT_ID);
    expect((ignored[0]!.detail as { added_capabilities: string[] }).added_capabilities).toEqual(['document.write']);
  });

  it('acts once however many times the same change is delivered', async () => {
    const { authz } = await runningAgent(['document.read', 'document.write']);
    await revoke(authz, 'document.write');
    const change = {
      human_subject: 'testuser', changed_at: '2026-03-03T00:00:00.000Z',
      capability_id: 'document.write', action: 'revoke',
    };

    expect((await deliver(authz, change)).status).toBe(204);
    expect((await deliver(authz, change)).status).toBe(204);

    expect(authz.reprovisions).toHaveLength(1);
  });
});
