import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { assertNoTokenInRedirect } from '@xaa/contracts';
import {
  STUB_CONNECTOR, completeConsent, createBridgeHarness, seedConnector, transactionReader,
} from '../src/testing/harness.js';

/**
 * Coming back from the SaaS with an authorization code.
 *
 * Two things leave this handler: a redirect and a Firestore row. The redirect carries
 * a transaction id and a one-time code and nothing else — no access token, no refresh
 * token, not the reason a failure happened in prose. The row is keyed on the person, so
 * a second consent widens the existing connection instead of creating a rival one that
 * nobody would refresh.
 *
 * `state` is read and deleted in one transaction. Split in two, a replayed callback
 * could pass the read before the delete landed and spend the same authorization code
 * twice.
 */
async function startAndAuthorize(harness: ReturnType<typeof createBridgeHarness>): Promise<URL> {
  const started = await harness.callback(
    `/${STUB_CONNECTOR.connector_id}/oauth/start?transaction_id=tx-1`, { redirect: 'manual' },
  );
  const authorized = await harness.stubOp.fetch(new Request(started.headers.get('location')!, { redirect: 'manual' }));
  return new URL(authorized.headers.get('location')!);
}

describe('the OAuth callback', () => {
  it('redirects back with exactly code and transaction_id', async () => {
    const harness = createBridgeHarness({ readTransaction: transactionReader() });
    await seedConnector(harness);
    const back = await startAndAuthorize(harness);
    const finished = await harness.callback(`${back.pathname}${back.search}`, { redirect: 'manual' });

    expect(finished.status).toBe(302);
    const location = finished.headers.get('location')!;
    expect([...new URL(location).searchParams.keys()].sort()).toEqual(['code', 'transaction_id']);
    // The same guard the handler runs before answering, asserted from outside it.
    expect(() => assertNoTokenInRedirect(location)).not.toThrow();
  });

  it('refuses a state offered twice, with no second redirect', async () => {
    const harness = createBridgeHarness({ readTransaction: transactionReader() });
    await seedConnector(harness);
    const back = await startAndAuthorize(harness);

    expect((await harness.callback(`${back.pathname}${back.search}`, { redirect: 'manual' })).status).toBe(302);
    const replayed = await harness.callback(`${back.pathname}${back.search}`, { redirect: 'manual' });
    expect(replayed.status).toBe(400);
    expect(replayed.headers.get('location')).toBeNull();
    expect(await replayed.json()).toEqual({ error: 'invalid_state' });
  });

  it('reports a failed code exchange as a slug and nothing else', async () => {
    const harness = createBridgeHarness({ readTransaction: transactionReader() });
    await seedConnector(harness);
    const back = await startAndAuthorize(harness);
    back.searchParams.set('code', 'a-code-the-saas-never-issued');

    const finished = await harness.callback(`${back.pathname}${back.search}`, { redirect: 'manual' });
    expect(finished.status).toBe(302);
    const location = new URL(finished.headers.get('location')!);
    expect([...location.searchParams.keys()].sort()).toEqual(['reason', 'transaction_id']);
    // One of three words. An exception message or the SaaS's own error body would put
    // whatever the far side chose to say into a URL in someone's browser history.
    expect(['invalid_state', 'code_exchange_failed', 'subject_unresolved'])
      .toContain(location.searchParams.get('reason'));
  });

  it('widens the existing connection instead of adding a second one', async () => {
    const shared = createFirestoreDouble();
    const first = createBridgeHarness({ shared, readTransaction: transactionReader({ scopes: ['calendar.read'] }) });
    await seedConnector(first);
    await completeConsent(first, { transactionId: 'tx-1' });

    const second = createBridgeHarness({
      shared, readTransaction: transactionReader({ scopes: ['calendar.read', 'gmail.send'] }),
    });
    await completeConsent(second, { transactionId: 'tx-2' });

    const rows = await second.documents.listAll<{ granted_scopes: string[]; created_at: string }>('bridge_connections');
    // One row, both scopes: the person granted each of them, and dropping the earlier
    // set would break the agents already bound to it.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.granted_scopes).toEqual(['calendar.read', 'gmail.send']);
  });
});
