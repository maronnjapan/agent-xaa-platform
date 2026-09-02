import { describe, expect, it } from 'vitest';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { reissueSubjectToken, requestIdJag, seedIdpConnection, startAgentOp } from '../../harness/agent-op.js';

/**
 * REQ-05-051 / DEC-ID-19. When the runtime's subject_token expires it does not get a
 * minted one: Agent OP spends the stored refresh token at Human IdP and hands back
 * only the `id_token` from that response. The ID Token used here is a real one from
 * the Human IdP harness, so the reissued token has to survive /xaa/token's own
 * verification against the shared JWK Set.
 */
async function humanIdToken(): Promise<string> {
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

describe('POST /xaa/subject-token', () => {
  it('runtime obtains a fresh ID Token and completes ID-JAG issuance', async () => {
    const fresh = await humanIdToken();
    const agentOp = await startAgentOp({
      idpPublicJwk: await idpPublicJwk(),
      // Human IdP's answer to grant_type=refresh_token: a new ID Token, a rotated
      // refresh token, and an access token Agent OP must not pass on.
      humanIdpFetch: (async () => Response.json({
        id_token: fresh, refresh_token: 'rt-2', access_token: 'at-1', expires_in: 3600,
      })) as unknown as typeof fetch,
    });
    await seedIdpConnection(agentOp);

    const response = await reissueSubjectToken(agentOp);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'subject_token', 'subject_token_type']);
    expect(body.subject_token).toBe(fresh);
    expect(body.subject_token_type).toBe('urn:ietf:params:oauth:token-type:id_token');

    // The reissued token carries the exchange through: same route, no special case.
    const issued = await requestIdJag(agentOp, { subjectToken: body.subject_token as string });
    expect(issued.status).toBe(200);
    const idJag = await issued.json() as { access_token: string; issued_token_type: string };
    expect(idJag.issued_token_type).toBe('urn:ietf:params:oauth:token-type:id-jag');
    const header = JSON.parse(Buffer.from(idJag.access_token.split('.')[0]!, 'base64url').toString('utf8')) as { typ: string };
    expect(header.typ).toBe('oauth-id-jag+jwt');

    // The rotated refresh token stays inside: it is re-encrypted, never returned.
    const stored = await agentOp.documents.get<{ encrypted_refresh_token: string }>('idp_connections', `idpconn-${agentOp.agentId}`);
    expect(Buffer.from(stored!.encrypted_refresh_token, 'base64').toString('utf8')).toBe(`${agentOp.agentId}::rt-2`);
    expect(JSON.stringify(body)).not.toContain('rt-2');
  });
});
