import { describe, expect, it } from 'vitest';
import {
  completionCodeId, PROVISIONING_CODES_COLLECTION, type CompletionCodeRecord,
} from '@xaa/contracts';
import { baseConfig, createFixture, decodeClientAuth, fakeEnvelope, type Fixture } from './helpers.js';

const TOKEN_BEARING = /(access_token|refresh_token|id_token|[?&#]token=)/;

async function seedState(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  await fixture.documents.set('bridge_consent_states', 'state-1', {
    transaction_id: 'txn-1',
    agent_id: fixture.agentId,
    human_subject: fixture.registration.human_subject,
    code_verifier: 'verifier-1',
    idp_connection_id: fixture.registration.idp_connection_id,
    expires_at: new Date(fixture.now() + 86_400_000).toISOString(),
    used: false,
    ...overrides,
  });
  await fixture.documents.set('provisioning_transactions', 'txn-1', { status: 'WAITING_IDP_CONSENT' });
}

const callback = (fixture: Fixture, query = 'code=auth-code&state=state-1') => fixture.fetch(`/xaa/callback?${query}`);

async function surfaceOf(response: Response): Promise<string> {
  const cookies = response.headers.getSetCookie?.() ?? [];
  return [response.headers.get('location') ?? '', await response.text(), ...cookies].join('\n');
}

describe('GET /xaa/callback', () => {
  it('stores only the refresh token and discards access_token and id_token', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1', access_token: 'at-1', id_token: 'id-1' }));
    const response = await callback(fixture);
    expect(response.status).toBe(302);
    const stored = await fixture.documents.get<{ encrypted_refresh_token: string; status: string }>('idp_connections', fixture.registration.idp_connection_id);
    expect(await fakeEnvelope.decrypt(stored!.encrypted_refresh_token, fixture.agentId)).toBe('rt-1');
    expect(stored!.status).toBe('ACTIVE');
    expect(JSON.stringify(stored)).not.toContain('at-1');
    expect(JSON.stringify(stored)).not.toContain('id-1');
  });

  /**
   * The transaction's status belongs to the Provisioner (00b §3): its resume route is
   * what takes WAITING_IDP_CONSENT to RESUMABLE. Moving it here first made that
   * transition illegal, and every resume answered 500.
   */
  it('leaves the transaction status for the Provisioner to move', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1' }));
    await callback(fixture);
    expect((await fixture.documents.get<{ status: string }>('provisioning_transactions', 'txn-1'))!.status)
      .toBe('WAITING_IDP_CONSENT');
  });

  it('authenticates the code exchange as the confidential agent-platform client', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1' }));
    expect((await callback(fixture)).status).toBe(302);
    expect(decodeClientAuth(fixture.humanIdpRequests[0]!.headers.authorization))
      .toEqual({ clientId: 'agent-platform', clientSecret: baseConfig().clientSecretAgentPlatform });
  });

  it('rejects a reused state', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1' }));
    expect((await callback(fixture)).status).toBe(302);
    expect((await callback(fixture)).status).toBe(400);
  });

  it('rejects callback without PKCE code_verifier in the transaction', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture, { code_verifier: '' });
    expect((await callback(fixture)).status).toBe(400);
    expect((await fixture.documents.get<{ status: string }>('provisioning_transactions', 'txn-1'))!.status).toBe('FAILED');
  });

  it('sets transaction to FAILED on error parameter', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    const response = await callback(fixture, 'error=access_denied&state=state-1');
    expect(response.status).toBe(400);
    expect((await fixture.documents.get<{ status: string }>('provisioning_transactions', 'txn-1'))!.status).toBe('FAILED');
  });

  it('carries no token-bearing parameter and sets no cookie on success', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1', access_token: 'at-1', id_token: 'id-1' }));
    const response = await callback(fixture);
    expect(await surfaceOf(response)).not.toMatch(TOKEN_BEARING);
    expect(response.headers.getSetCookie?.() ?? []).toHaveLength(0);
    expect(response.headers.get('location')).toMatch(/^https:\/\/automation-app\.test\/provisioning\/resume\?transaction_id=txn-1&code=/);
  });

  it('error response carries no token-bearing parameter', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    const response = await callback(fixture, 'error=access_denied&state=state-1');
    expect(await surfaceOf(response)).not.toMatch(TOKEN_BEARING);
  });

  /**
   * Where the code is written matters as much as that it is written: the Provisioner
   * redeems it out of `provisioning_codes` keyed by the code's hash, and a code stored
   * anywhere else is a consent that can never be resumed.
   */
  it('issues a one-time code where the Provisioner redeems it, hashed and unused', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1' }));
    const location = (await callback(fixture)).headers.get('location')!;
    const code = new URL(location).searchParams.get('code')!;

    const record = await fixture.documents.get<CompletionCodeRecord>(
      PROVISIONING_CODES_COLLECTION, await completionCodeId(code),
    );
    expect(record).toBeDefined();
    expect(record!.transaction_id).toBe('txn-1');
    expect(record!.human_subject).toBe('user-1');
    expect(record!.issuer_kind).toBe('idp');
    expect(record!.used_at).toBeNull();
    // The plaintext code is never a document id and never a stored value.
    expect(JSON.stringify(record)).not.toContain(code);
  });
});
