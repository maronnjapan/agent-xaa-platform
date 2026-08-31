import { describe, expect, it } from 'vitest';
import { jwkThumbprint } from '@xaa/crypto';
import { AGENT_URN_PREFIX } from '@xaa/contracts';
import { authorize, basicAuth, decodeJwtHeader, decodeJwtPayload, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { DOCS_AS_ISSUER, DOCS_API_RESOURCE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';

/** Logs a human in and returns the ID Token that becomes the subject_token. */
async function humanIdToken(idp: Awaited<ReturnType<typeof startHumanIdp>>): Promise<string> {
  const result = await authorize({
    fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
  });
  expect(result.code).toBeDefined();
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

describe('Human IdP to Agent OP: the first two XAA steps', () => {
  it('exchanges a real ID Token for an ID-JAG carrying cnf and act', async () => {
    const idp = await startHumanIdp();
    const subjectToken = await humanIdToken(idp);
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });

    const response = await requestIdJag(agentOp, { subjectToken });
    expect(response.status).toBe(200);
    const body = await response.json() as { access_token: string; issued_token_type: string; expires_in: number };
    expect(body.issued_token_type).toBe('urn:ietf:params:oauth:token-type:id-jag');

    const claims = decodeJwtPayload(body.access_token);
    expect(decodeJwtHeader(body.access_token).typ).toBe('oauth-id-jag+jwt');
    expect(claims.iss).toBe(HUMAN_IDP_ISSUER);
    expect(claims.sub).toBe('testuser');
    expect(claims.aud).toBe(DOCS_AS_ISSUER);
    expect(claims.resource).toBe(DOCS_API_RESOURCE);
    expect((claims.act as { sub: string }).sub).toBe(`${AGENT_URN_PREFIX}${agentOp.agentId}`);
    expect((claims.cnf as { jkt: string }).jkt).toBe(await jwkThumbprint(agentOp.dpopKeyPair.publicJwk));
  });

  it('refuses an ID Token issued to another human', async () => {
    const idp = await startHumanIdp();
    const subjectToken = await humanIdToken(idp);
    // The agent is delegated by someone else, so the pairing must be rejected.
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanSubject: 'someone-else' });
    const response = await requestIdJag(agentOp, { subjectToken });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_grant', error_description: 'The delegation relationship could not be verified',
    });
    expect(agentOp.events.filter((event) => event.detail.violation_code === 'delegation_mismatch')).toHaveLength(1);
  });

  it('refuses an audience outside the static configuration', async () => {
    const idp = await startHumanIdp();
    const subjectToken = await humanIdToken(idp);
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const response = await requestIdJag(agentOp, { subjectToken, audience: 'https://resource-finance-as.test' });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_scope');
    expect(agentOp.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('refuses an Access Token presented as a subject_token', async () => {
    const idp = await startHumanIdp();
    const result = await authorize({
      fetch: idp.fetch, clientId: 'automation-app', redirectUri: 'https://automation-app.test/callback',
      scope: 'openid', issuer: HUMAN_IDP_ISSUER,
    });
    const token = await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
      form: {
        grant_type: 'authorization_code', code: result.code!, redirect_uri: 'https://automation-app.test/callback',
        code_verifier: result.pkce.verifier, client_id: 'automation-app',
      },
    });
    const accessToken = (await token.json() as { access_token: string }).access_token;
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const response = await requestIdJag(agentOp, { subjectToken: accessToken });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('writes one exchange log and one ledger record per successful issuance', async () => {
    const idp = await startHumanIdp();
    const subjectToken = await humanIdToken(idp);
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    await requestIdJag(agentOp, { subjectToken });
    expect(agentOp.exchangeLogs).toHaveLength(1);
    expect(agentOp.ledgerLogs).toHaveLength(1);
    expect([...agentOp.exchangeLogs, ...agentOp.ledgerLogs].join('\n')).not.toMatch(/eyJ/);
    void basicAuth;
  });
});
