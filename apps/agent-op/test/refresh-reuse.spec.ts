import { describe, expect, it } from 'vitest';
import { createDpopProof } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE, EXTENDED_VALIDATION_CODES } from '@xaa/contracts';
import { AGENT_OP_BASE, clientAssertion, createFixture, fakeEnvelope, type Fixture } from './helpers.js';

const PATH = '/xaa/subject-token';
const ORIGINAL = 'rt-original';
const ROTATED = 'rt-rotated';

async function seedConnection(fixture: Fixture): Promise<void> {
  await fixture.documents.set('idp_connections', fixture.registration.idp_connection_id, {
    idp_connection_id: fixture.registration.idp_connection_id,
    agent_id: fixture.agentId,
    human_subject: fixture.registration.human_subject,
    encrypted_refresh_token: await fakeEnvelope.encrypt(ORIGINAL, fixture.agentId),
    granted_scopes: ['openid', 'offline_access'],
    status: 'ACTIVE',
    created_at: new Date(fixture.now()).toISOString(),
    expires_at: new Date(fixture.now() + 86_400_000).toISOString(),
  });
}

async function call(fixture: Fixture): Promise<Response> {
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

async function storedConnection(fixture: Fixture) {
  return fixture.documents.get<{ status: string; encrypted_refresh_token: string }>(
    'idp_connections', fixture.registration.idp_connection_id,
  );
}

/**
 * Rotates once, then replays the retired token.
 *
 * The retired token comes back to Human IdP, which refuses it; Agent OP is the only
 * holder of that value, so a refusal for a token it knows it rotated away is evidence
 * of a leak rather than an ordinary expiry (docs 09 §5.1).
 */
async function rotateThenReplay(fixture: Fixture) {
  fixture.humanIdpResponses.push(Response.json({ id_token: 'a.b.c', refresh_token: ROTATED }));
  expect((await call(fixture)).status).toBe(200);

  // The rotated token is now the stored one; put the retired value back so the next
  // call presents exactly what a thief would have.
  await fixture.documents.update('idp_connections', fixture.registration.idp_connection_id, {
    encrypted_refresh_token: await fakeEnvelope.encrypt(ORIGINAL, fixture.agentId),
  });
  fixture.humanIdpResponses.push(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  fixture.humanIdpResponses.push(new Response(null, { status: 200 }));
  return call(fixture);
}

/**
 * T-SEC-14 / REQ-09-025. Refresh token reuse, detected where the token lives.
 *
 * This is not one of the sixteen protocol violations — nothing about the request was
 * malformed — so it travels under the extended code and is reported once, alongside the
 * revocation it causes.
 */
describe('refresh token reuse', () => {
  it('second use of same refresh token is rejected', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);

    const replay = await rotateThenReplay(fixture);

    expect(replay.status).toBe(400);
    expect((await replay.json() as { error: string }).error).toBe('invalid_grant');
    // No new subject token, and no rotated token written over the connection: Human IdP
    // accepted the hand-back (the 200 above), so the ciphertext is dropped rather than
    // replaced (T-LIFE-06) — the row stays, the credential does not.
    const stored = await storedConnection(fixture);
    expect(stored).toBeTruthy();
    expect(stored!.encrypted_refresh_token).toBeUndefined();
  });

  it('marks connection revoked on reuse', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);

    await rotateThenReplay(fixture);

    // Uppercase is this collection's convention for `status` (00b §3); the point is that
    // the connection is no longer usable and nothing rolls that back.
    expect((await storedConnection(fixture))!.status).toBe('REVOKED');
    const line = JSON.parse(fixture.connectionLogs.at(-1)!) as { fields: { reuse_detected: boolean; revoke_result: string } };
    expect(line.fields.reuse_detected).toBe(true);
    expect(line.fields.revoke_result).toBe('ok');
  });

  it('emits refresh_token_reuse validation event', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);

    await rotateThenReplay(fixture);

    const reuse = fixture.events.filter((event) => event.detail.violation_code === 'refresh_token_reuse');
    expect(reuse).toHaveLength(1);
    expect(reuse[0]!.agent_id).toBe(fixture.agentId);
    // Kept apart from the sixteen: nothing about the request was malformed.
    expect(EXTENDED_VALIDATION_CODES).toContain('refresh_token_reuse');
    // Neither the retired token nor the rotated one appears anywhere in the record.
    const written = [...fixture.connectionLogs, JSON.stringify(fixture.events)].join('\n');
    expect(written).not.toContain(ORIGINAL);
    expect(written).not.toContain(ROTATED);
  });

  it('reports an ordinary expiry as a failure, not as reuse', async () => {
    const fixture = await createFixture();
    await seedConnection(fixture);
    fixture.humanIdpResponses.push(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    expect((await call(fixture)).status).toBe(400);

    expect(fixture.events.filter((event) => event.detail.violation_code === 'refresh_token_reuse')).toHaveLength(0);
    expect((await storedConnection(fixture))!.status).toBe('ACTIVE');
  });
});
