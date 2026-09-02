import { describe, expect, it } from 'vitest';
import { idpPublicJwk } from '../../harness/human-idp.js';
import {
  PROVISIONER_SA, reissueSubjectToken, revokeConnection, seedIdpConnection, startAgentOp,
} from '../../harness/agent-op.js';

/**
 * REQ-01-028 / RULE-22. Cleanup asks Agent OP to hand the refresh token back to Human
 * IdP; after that the connection is dead and the reissue route has nothing to spend.
 * The refresh token never leaves the process: it is not in the reply, not in the log.
 */
const humanIdp = (responses: Response[]) => (async () => responses.shift() ?? new Response(null, { status: 200 })) as unknown as typeof fetch;

describe('/internal/revoke-connection', () => {
  it('subject-token reissue after revoke returns invalid_grant', async () => {
    const revoked: string[] = [];
    const agentOp = await startAgentOp({
      idpPublicJwk: await idpPublicJwk(),
      humanIdpFetch: (async (_url: unknown, init: RequestInit) => {
        revoked.push(String(init.body));
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const connectionId = await seedIdpConnection(agentOp);

    const response = await revokeConnection(agentOp);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revoked: true, revoke_result: 'ok' });
    // RFC 7009, with the stored token and the platform client id.
    expect(revoked[0]).toContain('token_type_hint=refresh_token');
    expect(revoked[0]).toContain('client_id=agent-platform');
    expect((await agentOp.documents.get<{ status: string }>('idp_connections', connectionId))!.status).toBe('REVOKED');

    const reissued = await reissueSubjectToken(agentOp);
    expect(reissued.status).toBe(400);
    expect((await reissued.json() as { error: string }).error).toBe('invalid_grant');
    // Neither the reply nor the log carries the credential that was just spent.
    expect(agentOp.connectionLogs.join('\n')).not.toContain('rt-1');
  });

  it('refuses a caller that is not sa-lifecycle', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanIdpFetch: humanIdp([]) });
    const connectionId = await seedIdpConnection(agentOp);

    const response = await revokeConnection(agentOp, PROVISIONER_SA);
    expect(response.status).toBe(403);
    expect((await agentOp.documents.get<{ status: string }>('idp_connections', connectionId))!.status).toBe('ACTIVE');
  });
});
