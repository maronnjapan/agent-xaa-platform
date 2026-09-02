import { describe, expect, it } from 'vitest';
import { AGENT_URN_PREFIX, PLATFORM_CLIENT_ID } from '@xaa/contracts';
import { createDpopProof, generateEs256KeyPair, type Es256KeyPair } from '@xaa/crypto';
import { createClientRegistry } from '@xaa/human-idp/src/config/clients';
import { createAsClientResolver } from '@xaa/resource-docs-as/src/config/clients';
import { createProvisionerHarness, seedDecision, PROVISIONER_BASE, type ProvisionerHarness } from '@xaa/provisioner/src/testing/harness';
import { authorize, decodeJwtPayload, tokenRequest } from '../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, humanIdpEnv, idpPublicJwk, startHumanIdp } from '../harness/human-idp.js';
import { requestIdJag, startAgentOp } from '../harness/agent-op.js';

/**
 * RULE-50 / DEC-ID-22 / REQ-05-080. Making an agent registers no client anywhere.
 *
 * The alternative — a client per agent — would mean a registration to create and
 * revoke at three authorization servers every time an agent is made or expires, and a
 * secret held for each. Agents are made and discarded all day; that is a lot of
 * credentials whose deletion has to work every single time.
 *
 * Instead there is one client, `agent-platform`, and an individual agent is identified
 * by three things that are already there: the key in `cnf.jkt`, the `act` claim, and
 * the audit log. Three agents therefore produce three distinguishable ID-JAGs while the
 * client registries stay exactly as they were.
 */
interface Caller { token: string; keyPair: Es256KeyPair }

async function callerToken(): Promise<Caller> {
  const idp = await startHumanIdp();
  const keyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope: 'openid agent:provision', issuer: HUMAN_IDP_ISSUER, audience: 'agent-provisioner',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  const body = await response.json() as { access_token: string };
  return { token: body.access_token, keyPair };
}

async function provisionThree(provisioner: ProvisionerHarness, caller: Caller): Promise<string[]> {
  const agentIds: string[] = [];
  for (const task of ['a', 'b', 'c']) {
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const response = await provisioner.fetch('/provisioning', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${caller.token}`,
        DPoP: await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}/provisioning`, keyPair: caller.keyPair, accessToken: caller.token,
        }),
      },
      body: JSON.stringify({ decision_id: decisionId, task_id: task, requested_lifetime_hours: 1 }),
    });
    expect(response.status).toBe(201);
    agentIds.push((await response.json() as { agent_id: string }).agent_id);
  }
  return agentIds;
}

/** Logs a human in and returns the ID Token that becomes the subject_token. */
async function humanIdToken(idp: Awaited<ReturnType<typeof startHumanIdp>>): Promise<string> {
  const result = await authorize({
    fetch: idp.fetch, clientId: PLATFORM_CLIENT_ID, redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: PLATFORM_CLIENT_ID, clientSecret: 'agent-platform-secret', issuer: HUMAN_IDP_ISSUER,
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
      code_verifier: result.pkce.verifier, client_id: PLATFORM_CLIENT_ID,
    },
  });
  return (await response.json() as { id_token: string }).id_token;
}

describe('three agents, one registered client', () => {
  it('leaves the Human IdP and both Resource AS registries exactly as they were', async () => {
    const before = {
      humanIdp: [...createClientRegistry(humanIdpEnv).keys()].sort(),
      docsAs: await createAsClientResolver().findClient(PLATFORM_CLIENT_ID),
    };

    const provisioner = await createProvisionerHarness({ idpPublicJwk: await idpPublicJwk() });
    const agentIds = await provisionThree(provisioner, await callerToken());
    expect(new Set(agentIds).size).toBe(3);

    const after = {
      humanIdp: [...createClientRegistry(humanIdpEnv).keys()].sort(),
      docsAs: await createAsClientResolver().findClient(PLATFORM_CLIENT_ID),
    };
    expect(after.humanIdp).toEqual(before.humanIdp);
    expect(after.humanIdp).toEqual(['agent-platform', 'automation-app']);
    expect(after.docsAs).toEqual(before.docsAs);

    // And none of the three agents became a client of any of them.
    for (const agentId of agentIds) {
      expect(createClientRegistry(humanIdpEnv).get(agentId)).toBeUndefined();
      expect(await createAsClientResolver().findClient(agentId)).toBe(null);
    }
    // The Resource AS knows one client id, and it is the platform constant.
    expect(await createAsClientResolver().findClient('example-client')).toBe(null);
  });

  it('issues three ID-JAGs under one client id with three different actors', async () => {
    const idp = await startHumanIdp();
    const idpJwk = await idpPublicJwk();
    const provisioner = await createProvisionerHarness({ idpPublicJwk: idpJwk });
    const agentIds = await provisionThree(provisioner, await callerToken());

    const claims: Array<Record<string, unknown>> = [];
    for (const agentId of agentIds) {
      // Each agent's own Agent OP view. The private half of a provisioned agent's
      // credential lives only inside its Execution and was never written down
      // (RULE-22), so the harness registers the same agent id against a key it holds —
      // which is the only way anything outside an Execution can act as one at all.
      const agentOp = await startAgentOp({ idpPublicJwk: idpJwk, agentId });
      const response = await requestIdJag(agentOp, { subjectToken: await humanIdToken(idp) });
      expect(response.status).toBe(200);
      claims.push(decodeJwtPayload((await response.json() as { access_token: string }).access_token));
    }

    expect(claims).toHaveLength(3);
    // One client id on all three: the ID-JAG says which platform asked, and `act` says
    // which agent it asked for. Putting the agent in `client_id` would conflate them.
    expect(claims.map((claim) => claim.client_id)).toEqual([PLATFORM_CLIENT_ID, PLATFORM_CLIENT_ID, PLATFORM_CLIENT_ID]);
    const actors = claims.map((claim) => (claim.act as { sub: string }).sub);
    expect(new Set(actors).size).toBe(3);
    expect(actors).toEqual(agentIds.map((agentId) => `${AGENT_URN_PREFIX}${agentId}`));
    // The person is the same in all three; the agents differ.
    expect(new Set(claims.map((claim) => claim.sub))).toEqual(new Set(['testuser']));
  });
});
