import { describe, expect, it } from 'vitest';
import {
  CALLBACK_BASE, SA, STUB_CONNECTOR, createBridgeHarness, seedConnection, seedConnector,
} from '../src/testing/harness.js';
import { connectionId } from '../src/store/connection.js';

/**
 * The question the Provisioner asks before it sends anyone to a consent screen.
 *
 * REQ-06-018 is the point of the whole route: the second, third and tenth agent for the
 * same person must reuse the connection the first one's consent produced. If this
 * answered `CONSENT_REQUIRED` whenever it was unsure, provisioning would open a browser
 * every time and the platform would be teaching people to click through OAuth screens.
 *
 * Only two answers exist. A third — "probably fine", "partially connected" — would put
 * the decision back on the caller, and the caller is the one that cannot see the
 * connection.
 */
const check = (harness: ReturnType<typeof createBridgeHarness>, body: unknown, transactionId = 'tx-1') =>
  harness.internal('/connections/check', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer caller',
      'X-Transaction-Id': transactionId,
    },
    body: JSON.stringify(body),
  });

const request = (overrides: Record<string, unknown> = {}) => ({
  connector_id: STUB_CONNECTOR.connector_id,
  human_subject: 'testuser',
  required_scopes: ['calendar.read'],
  ...overrides,
});

describe('checking a connection', () => {
  it('未接続 -> CONSENT_REQUIRED', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    await seedConnector(harness);
    const response = await check(harness, request());
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; consent_url: string; missing_scopes: string[] };
    expect(body.status).toBe('CONSENT_REQUIRED');
    expect(body.missing_scopes).toEqual(['calendar.read']);
    // The Bridge says where consent would start; it does not start it. Redirecting is
    // the Automation App's decision to make, in front of the person.
    expect(body.consent_url).toBe(
      `${CALLBACK_BASE}/${STUB_CONNECTOR.connector_id}/oauth/start?transaction_id=tx-1`,
    );
  });

  it('scope不足 -> CONSENT_REQUIRED + missing_scopes は差分のみ', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    await seedConnector(harness);
    await seedConnection(harness, { grantedScopes: ['calendar.read'] });
    const response = await check(harness, request({ required_scopes: ['calendar.read', 'gmail.send'] }));
    const body = await response.json() as { status: string; missing_scopes: string[] };
    expect(body.status).toBe('CONSENT_REQUIRED');
    // The difference, not the whole requirement: asking the person to approve
    // `calendar.read` again, which they already granted, invites them to stop reading.
    expect(body.missing_scopes).toEqual(['gmail.send']);
  });

  it('充足 -> READY + connection_id', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    await seedConnector(harness);
    await seedConnection(harness, { grantedScopes: ['calendar.read'] });
    const response = await check(harness, request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'READY',
      connection_id: connectionId(STUB_CONNECTOR.connector_id, 'testuser'),
    });
  });

  it('answers READY twice for the same person and adds no second connection', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    await seedConnector(harness);
    await seedConnection(harness, { grantedScopes: ['calendar.read'] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await (await check(harness, request())).json()).toMatchObject({ status: 'READY' });
    }
    // Still one connection: the second agent reuses the first's consent (REQ-06-018).
    expect(await harness.documents.listAll('bridge_connections')).toHaveLength(1);
  });

  it('treats a revoked connection as needing consent again', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    await seedConnector(harness);
    await seedConnection(harness, { status: 'REVOKED' });
    expect(await (await check(harness, request())).json()).toMatchObject({ status: 'CONSENT_REQUIRED' });
  });

  it('refuses a caller that is not the Provisioner', async () => {
    const harness = createBridgeHarness({ caller: SA.runtime });
    const response = await check(harness, request({ required_scopes: [] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_caller' });
  });
});
