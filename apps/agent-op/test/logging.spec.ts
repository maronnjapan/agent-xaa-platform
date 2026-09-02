import { describe, expect, it } from 'vitest';
import { createDpopProof } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE } from '@xaa/contracts';
import { expectLogFields } from '@xaa/logging';
import { AGENT_OP_BASE, clientAssertion, createFixture, exchange, fakeEnvelope } from './helpers.js';

const SUBJECT_TOKEN_PATH = '/xaa/subject-token';

/**
 * T-SEC-05: one `app.fetch` call, one captured stdout line, and the shared
 * `expectLogFields` helper checks it against `IDENTITY_EVENT_FIELDS` rather than a
 * hand-copied field list. Agent OP owns two of the five identity events.
 */
describe('Agent OP structured logging', () => {
  it('expectLogFields recognizes agent_op.token_exchange', async () => {
    const fixture = await createFixture();
    await exchange(fixture);
    expect(fixture.exchangeLogs).toHaveLength(1);
    const fields = expectLogFields(fixture.exchangeLogs[0]!, 'agent_op.token_exchange');
    expect(fields.delegation_match).toBe(true);
    expect(fields.issued_jti).toBeTypeOf('string');
  });

  it('expectLogFields recognizes agent_op.idp_connection', async () => {
    const fixture = await createFixture();
    await fixture.documents.set('idp_connections', fixture.registration.idp_connection_id, {
      idp_connection_id: fixture.registration.idp_connection_id,
      agent_id: fixture.agentId,
      human_subject: fixture.registration.human_subject,
      encrypted_refresh_token: await fakeEnvelope.encrypt('rt-original', fixture.agentId),
      granted_scopes: ['openid', 'offline_access'],
      status: 'ACTIVE',
      created_at: new Date(fixture.now()).toISOString(),
      expires_at: new Date(fixture.now() + 86_400_000).toISOString(),
    });
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c' }));
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      DPoP: await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}${SUBJECT_TOKEN_PATH}`, keyPair: fixture.dpopKeyPair, now: fixture.now }),
    };
    const form = {
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(fixture, { path: SUBJECT_TOKEN_PATH }),
    };
    await fixture.fetch(SUBJECT_TOKEN_PATH, { method: 'POST', headers, body: new URLSearchParams(form).toString() });

    expect(fixture.connectionLogs).toHaveLength(1);
    const fields = expectLogFields(fixture.connectionLogs[0]!, 'agent_op.idp_connection');
    expect(fields.subject_token_refetch_result).toBe('ok');
  });
});
