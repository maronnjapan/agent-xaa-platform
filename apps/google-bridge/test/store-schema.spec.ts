import { describe, expect, it } from 'vitest';
import { connectionId } from '../src/store/connection.js';
import { SA, STUB_CONNECTOR, createBridgeHarness, seedConnection } from '../src/testing/harness.js';

/**
 * T-BRIDGE-04. A Bridge Connection is keyed by `(connector_id, human_subject)`, so the
 * same person consenting to the same connector twice lands on the same document rather
 * than piling up rows the cleanup would have to hunt for (REQ-06-018).
 */
describe('the bridge connection store', () => {
  it('derives the same connection_id for the same connector and person, and keeps one row', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    const first = await seedConnection(harness, { humanSubject: 'testuser' });
    const second = await seedConnection(harness, { humanSubject: 'testuser' });

    expect(second).toBe(first);
    expect(first).toBe(connectionId(STUB_CONNECTOR.connector_id, 'testuser'));
    expect(await harness.documents.listAll('bridge_connections')).toHaveLength(1);
  });

  it('separates two people on the same connector', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    const a = await seedConnection(harness, { humanSubject: 'user-a' });
    const b = await seedConnection(harness, { humanSubject: 'user-b' });

    expect(a).not.toBe(b);
    expect(await harness.documents.listAll('bridge_connections')).toHaveLength(2);
  });

  it('stores the connection in the shape the Bridge reads back', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    const id = await seedConnection(harness);
    const row = await harness.documents.get<Record<string, unknown>>('bridge_connections', id);

    expect(row).toBeTruthy();
    expect(Object.keys(row!).sort()).toEqual([
      'connection_id', 'connector_id', 'created_at', 'encrypted_refresh_token', 'expires_at',
      'external_subject', 'granted_scopes', 'human_subject', 'status',
    ]);
    expect(row!.connection_id).toBe(id);
    // The refresh token is stored as ciphertext only: bytes, never the string.
    expect(typeof row!.encrypted_refresh_token).not.toBe('string');
  });
});
