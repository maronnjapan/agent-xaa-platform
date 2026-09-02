import { describe, expect, it } from 'vitest';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { requestIdJag, startAgentOp } from '../../harness/agent-op.js';

/**
 * REQ-05-071 / RULE-49, the attack draft §9.7 names: an agent delegated by one person
 * presenting another person's ID Token. Both halves are real here — the subject_token
 * is minted by Human IdP for `testuser`, the registration delegates from someone else.
 */
async function idTokenForTestuser(): Promise<string> {
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
  expect(response.status).toBe(200);
  return (await response.json() as { id_token: string }).id_token;
}

describe('delegation mismatch at /xaa/token', () => {
  it('returns 400 and invalid_grant when the human does not match the registration', async () => {
    const subjectToken = await idTokenForTestuser();
    const agentOp = await startAgentOp({
      idpPublicJwk: await idpPublicJwk(),
      // The registration delegates from somebody else entirely.
      humanSubject: 'another-person',
    });

    const response = await requestIdJag(agentOp, { subjectToken });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_grant', error_description: 'The delegation relationship could not be verified',
    });
  });

  it('records exactly one delegation_mismatch event', async () => {
    const subjectToken = await idTokenForTestuser();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanSubject: 'another-person' });
    await requestIdJag(agentOp, { subjectToken });

    const violations = agentOp.events.filter((event) => event.detail.violation_code === 'delegation_mismatch');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.event_type).toBe('PROTOCOL_VIOLATION');
    expect(violations[0]!.phase).toBe('security');
    expect(violations[0]!.outcome).toBe('blocked');
    // The exchange log carries the same verdict, and no grant was written to the ledger.
    expect((JSON.parse(agentOp.exchangeLogs.at(-1)!) as { fields: { delegation_match: boolean } }).fields.delegation_match).toBe(false);
    expect(agentOp.ledgerLogs).toHaveLength(0);
  });
});
