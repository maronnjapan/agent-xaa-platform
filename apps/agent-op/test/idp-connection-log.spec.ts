import { describe, expect, it } from 'vitest';
import { createDpopProof } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE } from '@xaa/contracts';
import { refreshTokenFingerprint } from '../src/idp-connection/crypto.js';
import {
  AGENT_OP_BASE, clientAssertion, createFixture, fakeEnvelope, LIFECYCLE_SA, type Fixture,
} from './helpers.js';

const PATH = '/xaa/subject-token';
const FIELDS = ['idp_connection_id', 'refresh_rotation_result', 'refresh_reuse_detected', 'subject_token_refetch_result', 'revoke_result'];

async function seedConnection(fixture: Fixture): Promise<void> {
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
}

async function reissue(fixture: Fixture): Promise<Response> {
  return fixture.fetch(PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      DPoP: await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}${PATH}`, keyPair: fixture.dpopKeyPair, now: fixture.now }),
    },
    body: new URLSearchParams({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(fixture, { path: PATH }),
    }).toString(),
  });
}

const revoke = (fixture: Fixture) => fixture.fetch('/internal/revoke-connection', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${LIFECYCLE_SA}` },
  body: JSON.stringify({ agent_id: fixture.agentId }),
});

const fieldsOf = (line: string) => (JSON.parse(line) as { fields: Record<string, unknown> }).fields;

/**
 * REQ-09-009 / docs 09 §2. The same five keys on all three paths: a key dropped
 * because a path had nothing to say is a column that reads as absent rather than as
 * `n/a`. The correlation key is the connection id — neither `agent_id` nor
 * `human_subject` belongs in this record.
 */
describe('IdP connection log', () => {
  it('rotation path emits all 5 fields', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c', refresh_token: 'rt-new' }));
    expect((await reissue(fixture)).status).toBe(200);

    expect(fixture.connectionLogs).toHaveLength(1);
    const record = fieldsOf(fixture.connectionLogs[0]!);
    expect(Object.keys(record).sort()).toEqual([...FIELDS].sort());
    expect(record).toMatchObject({
      idp_connection_id: fixture.registration.idp_connection_id,
      refresh_rotation_result: 'rotated',
      refresh_reuse_detected: false,
      subject_token_refetch_result: 'ok',
      revoke_result: 'n/a',
    });
    expect(record).not.toHaveProperty('agent_id');
    expect(record).not.toHaveProperty('human_subject');
  });

  it('reuse path emits refresh_reuse_detected=true', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c', refresh_token: 'rt-new' }));
    await reissue(fixture);
    // Put the retired token back, then have Human IdP refuse it the way it does after
    // rotation: the same token, presented twice.
    await fixture.documents.update('idp_connections', fixture.registration.idp_connection_id, {
      encrypted_refresh_token: await fakeEnvelope.encrypt('rt-original', fixture.agentId),
    });
    fixture.humanIdpResponses.push(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    fixture.humanIdpResponses.push(new Response(null, { status: 200 }));
    expect((await reissue(fixture)).status).toBe(400);

    const record = fieldsOf(fixture.connectionLogs[1]!);
    expect(Object.keys(record).sort()).toEqual([...FIELDS].sort());
    expect(record.refresh_reuse_detected).toBe(true);
    expect(record.subject_token_refetch_result).toBe('failed');
  });

  it('revoke path emits revoke_result', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(new Response(null, { status: 200 }));
    expect((await revoke(fixture)).status).toBe(200);
    const ok = fieldsOf(fixture.connectionLogs[0]!);
    expect(Object.keys(ok).sort()).toEqual([...FIELDS].sort());
    expect(ok.revoke_result).toBe('ok');
    expect(ok.refresh_rotation_result).toBe('not_rotated');
    expect(ok.subject_token_refetch_result).toBe('n/a');

    const failing = await createFixture();
    await seedConnection(failing);
    failing.humanIdpResponses.push(new Response('nope', { status: 500 }));
    await revoke(failing);
    expect(fieldsOf(failing.connectionLogs[0]!).revoke_result).toBe('failed');
  });

  it('no record contains the refresh token or its ciphertext or its hash', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c', refresh_token: 'rt-new' }));
    await reissue(fixture);
    fixture.humanIdpResponses.push(new Response(null, { status: 200 }));
    await revoke(fixture);

    const written = fixture.connectionLogs.join('\n');
    expect(fixture.connectionLogs.length).toBeGreaterThanOrEqual(2);
    for (const secret of [
      'rt-original',
      'rt-new',
      await fakeEnvelope.encrypt('rt-original', fixture.agentId),
      await fakeEnvelope.encrypt('rt-new', fixture.agentId),
      await refreshTokenFingerprint('rt-original'),
      await refreshTokenFingerprint('rt-new'),
    ]) {
      expect(written).not.toContain(secret);
    }
  });
});
