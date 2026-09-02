import { describe, expect, it } from 'vitest';
import { STUB_CONNECTOR, createBridgeHarness, seedConnector, transactionReader } from '../src/testing/harness.js';

/**
 * Where consent begins, and the one place the Bridge sends a browser somewhere.
 *
 * The destination is built entirely from the connector definition. Nothing in the
 * request contributes a host, a path or a scheme, so there is no open redirect to find
 * here however the query is manipulated — the worst a caller can do is name a
 * transaction that does not exist, which produces a 400 and no `Location` at all.
 *
 * The transaction is checked before any state row is written. A 400 that had already
 * stored a `code_verifier` would leave a usable state behind for a later replay.
 */
const start = (harness: ReturnType<typeof createBridgeHarness>, query: string) =>
  harness.callback(`/${STUB_CONNECTOR.connector_id}/oauth/start?${query}`, { redirect: 'manual' });

describe('starting consent', () => {
  it('unknown transaction_id -> 400 かつ Location ヘッダ無し', async () => {
    const harness = createBridgeHarness({ readTransaction: async () => undefined });
    await seedConnector(harness);
    const response = await start(harness, 'transaction_id=nobody-made-this');
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({ error: 'invalid_transaction' });
    // Nothing written, so nothing to replay.
    expect(await harness.documents.listAll('bridge_consent_states')).toHaveLength(0);
  });

  it('refuses a transaction that is not WAITING_EXTERNAL_CONSENT', async () => {
    const harness = createBridgeHarness({ readTransaction: transactionReader({ status: 'COMPLETED' }) });
    await seedConnector(harness);
    const response = await start(harness, 'transaction_id=tx-1');
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({ error: 'invalid_transaction' });
    expect(await harness.documents.listAll('bridge_consent_states')).toHaveLength(0);
  });

  it('carries state, PKCE and the offline prompt into the redirect', async () => {
    const harness = createBridgeHarness({ readTransaction: transactionReader() });
    await seedConnector(harness);
    const response = await start(harness, 'transaction_id=tx-1');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);

    expect(location.origin + location.pathname).toBe(STUB_CONNECTOR.authorization_endpoint);
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    // S256 only: `plain` would put the verifier in the very request PKCE protects.
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    // Without both of these the SaaS returns no refresh token, and the connection
    // would last exactly one access token.
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');

    const state = await harness.documents.get<{ code_verifier: string; expire_at: string }>(
      'bridge_consent_states', location.searchParams.get('state')!,
    );
    expect(state!.code_verifier.length).toBeGreaterThanOrEqual(43);
    expect(state!.expire_at).toBeTruthy();
  });

  it('sends exactly the nine query keys and no more', async () => {
    const harness = createBridgeHarness({ readTransaction: transactionReader() });
    await seedConnector(harness);
    const response = await start(harness, 'transaction_id=tx-1');
    const location = new URL(response.headers.get('location')!);
    // Fixed, because anything else in this URL is something the Bridge decided to tell
    // an external service about a person's provisioning.
    expect([...location.searchParams.keys()].sort()).toEqual([
      'access_type', 'client_id', 'code_challenge', 'code_challenge_method',
      'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
    ]);
  });
});
