import { describe, expect, it } from 'vitest';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { requestIdJag, startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';

async function subjectToken(): Promise<string> {
  const idp = await startHumanIdp();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'agent-platform', clientSecret: 'agent-platform-secret', issuer: HUMAN_IDP_ISSUER,
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
      code_verifier: result.pkce.verifier, client_id: 'agent-platform',
    },
  });
  return (await response.json() as { id_token: string }).id_token;
}

/**
 * Security Detection asks Lifecycle Manager to move the agent, and Lifecycle is the
 * only writer of `status` (00b §3). The test writes through a lifecycle-scoped store
 * so the access matrix is exercised the same way it is in production.
 */
async function quarantine(agentOp: AgentOpHarness): Promise<void> {
  await agentOp.lifecycleStore.update('agents', `${agentOp.agentId}__meta`, { status: 'QUARANTINED' });
}

describe('quarantine stops issuance', () => {
  it('no ID-JAG is issued once the registration is quarantined', async () => {
    const token = await subjectToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    expect((await requestIdJag(agentOp, { subjectToken: token })).status).toBe(200);

    await quarantine(agentOp);

    const response = await requestIdJag(agentOp, { subjectToken: token });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('reports the state in the exchange log as not_active', async () => {
    const token = await subjectToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    await quarantine(agentOp);
    await requestIdJag(agentOp, { subjectToken: token });
    const trace = (JSON.parse(agentOp.exchangeLogs.at(-1)!) as {
      fields: { agent_expiry_check: string; error_code: string };
    }).fields;
    expect(trace.agent_expiry_check).toBe('not_active');
    expect(trace.error_code).toBe('invalid_grant');
  });

  it('stops issuance once the registration expires', async () => {
    const token = await subjectToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    await agentOp.lifecycleStore.update('agents', `${agentOp.agentId}__meta`, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const response = await requestIdJag(agentOp, { subjectToken: token });
    expect(response.status).toBe(400);
    expect((JSON.parse(agentOp.exchangeLogs.at(-1)!) as {
      fields: { agent_expiry_check: string };
    }).fields.agent_expiry_check).toBe('expired');
  });
});
