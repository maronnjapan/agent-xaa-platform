import { describe, expect, it } from 'vitest';
import { createDpopProof } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE } from '@xaa/contracts';
import { AGENT_OP_BASE, clientAssertion, createFixture, fakeEnvelope, type Fixture } from './helpers.js';

const PATH = '/xaa/subject-token';

async function seedConnection(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const seed = (await import('@xaa/gcp')).createFirestoreDocumentStore;
  void seed;
  await fixture.documents.set('idp_connections', fixture.registration.idp_connection_id, {
    idp_connection_id: fixture.registration.idp_connection_id,
    agent_id: fixture.agentId,
    human_subject: fixture.registration.human_subject,
    encrypted_refresh_token: await fakeEnvelope.encrypt('rt-original', fixture.agentId),
    granted_scopes: ['openid', 'offline_access'],
    status: 'ACTIVE',
    created_at: new Date(fixture.now()).toISOString(),
    expires_at: new Date(fixture.now() + 86_400_000).toISOString(),
    ...overrides,
  });
}

async function call(fixture: Fixture, options: { omitProof?: boolean; omitAssertion?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (!options.omitProof) {
    headers.DPoP = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}${PATH}`, keyPair: fixture.dpopKeyPair, now: fixture.now });
  }
  const form: Record<string, string> = options.omitAssertion ? {} : {
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: await clientAssertion(fixture, { path: PATH }),
  };
  return fixture.fetch(PATH, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
}

describe('POST /xaa/subject-token', () => {
  it('returns only the ID Token, never the tokens beside it', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'header.payload.sig', access_token: 'at', refresh_token: 'rt-new', expires_in: 3600 }));
    const response = await call(fixture);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'subject_token', 'subject_token_type']);
    expect(body.subject_token).toBe('header.payload.sig');
    expect(body.subject_token_type).toBe('urn:ietf:params:oauth:token-type:id_token');
  });

  it('rotates the stored refresh token when a new one comes back', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c', refresh_token: 'rt-new' }));
    await call(fixture);
    const stored = await fixture.documents.get<{ encrypted_refresh_token: string }>('idp_connections', fixture.registration.idp_connection_id);
    expect(await fakeEnvelope.decrypt(stored!.encrypted_refresh_token, fixture.agentId)).toBe('rt-new');
    expect((JSON.parse(fixture.connectionLogs[0]!) as { fields: { rotation_result: string } }).fields.rotation_result).toBe('rotated');
  });

  it('keeps the existing ciphertext when the response has no refresh_token', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c' }));
    await call(fixture);
    const stored = await fixture.documents.get<{ encrypted_refresh_token: string }>('idp_connections', fixture.registration.idp_connection_id);
    expect(await fakeEnvelope.decrypt(stored!.encrypted_refresh_token, fixture.agentId)).toBe('rt-original');
    expect((JSON.parse(fixture.connectionLogs[0]!) as { fields: { rotation_result: string } }).fields.rotation_result).toBe('not_rotated');
  });

  it('rejects a request without DPoP', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    expect((await call(fixture, { omitProof: true })).status).toBe(400);
  });

  it('rejects a request without client_assertion', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    expect((await call(fixture, { omitAssertion: true })).status).toBe(401);
  });

  it('rejects a QUARANTINED agent with invalid_grant', async () => {
    const fixture = await createFixture({ registration: { status: 'QUARANTINED' } });
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c' }));
    const response = await call(fixture);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects a REVOKED connection with invalid_grant', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture, { status: 'REVOKED' });
    const response = await call(fixture);
    expect(response.status).toBe(400);
  });

  it('emits all five connection log fields on every path', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c', refresh_token: 'rt-new' }));
    await call(fixture);
    const line = JSON.parse(fixture.connectionLogs[0]!) as Record<string, unknown>;
    expect(line.log_source).toBe('agent_op_idp_connection');
    const record = line.fields as Record<string, unknown>;
    for (const field of ['idp_connection_id', 'rotation_result', 'reuse_detected', 'subject_token_reissue', 'revoke_result']) {
      expect(Object.keys(record)).toContain(field);
    }
    expect(record).not.toHaveProperty('agent_id');
    expect(record).not.toHaveProperty('human_subject');
    expect(fixture.connectionLogs.join()).not.toContain('rt-new');
    expect(fixture.connectionLogs.join()).not.toContain('rt-original');
  });
});

describe('refresh token reuse detection', () => {
  it('reports reuse only for a token that was actually rotated away', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    // First call rotates rt-original away.
    fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c', refresh_token: 'rt-new' }));
    await call(fixture);
    // Put the retired token back so the next call presents it again, then have
    // Human IdP reject it the way it would after rotation.
    await fixture.documents.update('idp_connections', fixture.registration.idp_connection_id, {
      encrypted_refresh_token: await fakeEnvelope.encrypt('rt-original', fixture.agentId),
    });
    fixture.humanIdpResponses.push(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    fixture.humanIdpResponses.push(new Response(null, { status: 200 }));
    const response = await call(fixture);
    expect(response.status).toBe(400);
    expect(fixture.events.filter((event) => event.detail.violation_code === 'refresh_token_reuse')).toHaveLength(1);
    const stored = await fixture.documents.get<{ status: string }>('idp_connections', fixture.registration.idp_connection_id);
    expect(stored!.status).toBe('REVOKED');
  });

  it('does not emit reuse for a token that was never rotated', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const response = await call(fixture);
    expect(response.status).toBe(400);
    expect(fixture.events.filter((event) => event.detail.violation_code === 'refresh_token_reuse')).toHaveLength(0);
  });
});
