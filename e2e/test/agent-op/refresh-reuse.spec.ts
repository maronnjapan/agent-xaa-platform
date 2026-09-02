import { describe, expect, it } from 'vitest';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { reissueSubjectToken, seedIdpConnection, startAgentOp, type AgentOpHarness } from '../../harness/agent-op.js';

/**
 * REQ-09-025. Agent OP is the only holder of an agent's refresh token, so the same
 * token coming back after a rotation is evidence of a leak rather than a race: the
 * connection is revoked, the token is handed back to Human IdP, and the caller learns
 * nothing beyond invalid_grant.
 *
 * Human IdP is scripted here — rotate once, then refuse the retired token the way it
 * does after rotation (e2e/test/refresh-reuse.spec.ts drives that half against the
 * real provider).
 */
function scriptedHumanIdp(responses: Array<() => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    calls.push(String(init.body));
    return (responses.shift() ?? (() => new Response(null, { status: 200 })))();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function replayRetiredToken(agentOp: AgentOpHarness): Promise<Response> {
  // First call rotates rt-1 away and stores rt-2.
  expect((await reissueSubjectToken(agentOp)).status).toBe(200);
  // The agent presents the retired token again: put it back the way a leaked copy
  // would arrive, then let Human IdP refuse it.
  await agentOp.documents.update('idp_connections', `idpconn-${agentOp.agentId}`, {
    encrypted_refresh_token: Buffer.from(`${agentOp.agentId}::rt-1`, 'utf8').toString('base64'),
  });
  return reissueSubjectToken(agentOp);
}

describe('refresh token reuse at /xaa/subject-token', () => {
  it('second use of the same refresh token returns invalid_grant', async () => {
    const script = scriptedHumanIdp([
      () => Response.json({ id_token: 'a.b.c', refresh_token: 'rt-2', expires_in: 3600 }),
      () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    ]);
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanIdpFetch: script.fetchImpl });
    await seedIdpConnection(agentOp);

    const replayed = await replayRetiredToken(agentOp);
    expect(replayed.status).toBe(400);
    expect((await replayed.json() as { error: string }).error).toBe('invalid_grant');
    expect(agentOp.events.filter((event) => event.detail.violation_code === 'refresh_token_reuse')).toHaveLength(1);
    // Detection order: the event, then the local revocation, then Human IdP's /revoke.
    expect(script.calls.at(-1)).toContain('token_type_hint=refresh_token');
  });

  it('marks the idp_connection revoked', async () => {
    const script = scriptedHumanIdp([
      () => Response.json({ id_token: 'a.b.c', refresh_token: 'rt-2', expires_in: 3600 }),
      () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    ]);
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanIdpFetch: script.fetchImpl });
    const connectionId = await seedIdpConnection(agentOp);

    await replayRetiredToken(agentOp);
    const stored = await agentOp.documents.get<{ status: string }>('idp_connections', connectionId);
    expect(stored!.status).toBe('REVOKED');
    // And the connection log says why, without naming the token or its hash.
    const record = (JSON.parse(agentOp.connectionLogs.at(-1)!) as { fields: Record<string, unknown> }).fields;
    expect(record.reuse_detected).toBe(true);
    expect(agentOp.connectionLogs.join('\n')).not.toContain('rt-1');
    expect(agentOp.connectionLogs.join('\n')).not.toContain('rt-2');
  });
});
