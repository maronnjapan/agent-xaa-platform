import { describe, expect, it } from 'vitest';
import { createFixture, fakeEnvelope, type Fixture } from './helpers.js';

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

  it('moves the transaction to RESUMABLE', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1' }));
    await callback(fixture);
    expect((await fixture.documents.get<{ status: string }>('provisioning_transactions', 'txn-1'))!.status).toBe('RESUMABLE');
  });

  it('rejects a reused state', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1' }));
    expect((await callback(fixture)).status).toBe(302);
    expect((await callback(fixture)).status).toBe(400);
  });

  it('rejects a transaction without a PKCE verifier', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture, { code_verifier: '' });
    expect((await callback(fixture)).status).toBe(400);
    expect((await fixture.documents.get<{ status: string }>('provisioning_transactions', 'txn-1'))!.status).toBe('FAILED');
  });

  it('marks the transaction FAILED on an error parameter', async () => {
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

  it('carries no token-bearing parameter on failure', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    const response = await callback(fixture, 'error=access_denied&state=state-1');
    expect(await surfaceOf(response)).not.toMatch(TOKEN_BEARING);
  });

  it('issues a one-time code that is stored unused with a TTL', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    await seedState(fixture);
    fixture.humanIdpResponses.push(Response.json({ refresh_token: 'rt-1' }));
    const location = (await callback(fixture)).headers.get('location')!;
    const code = new URL(location).searchParams.get('code')!;
    const record = await fixture.documents.get<{ transaction_id: string; used: boolean }>('bridge_consent_codes', code);
    expect(record).toBeDefined();
    expect(record!.transaction_id).toBe('txn-1');
    expect(record!.used).toBe(false);
  });
});
