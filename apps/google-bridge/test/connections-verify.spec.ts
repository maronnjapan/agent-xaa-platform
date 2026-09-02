import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import {
  SA, completeConsent, createBridgeHarness, seedConnector, transactionReader, type BridgeHarness,
} from '../src/testing/harness.js';

/**
 * The Provisioner's half of coming back from consent.
 *
 * The one-time code is spent on the first presentation, whatever the answer turns out
 * to be — including when the transaction id does not match. A code that survived a
 * mismatched attempt could be retried with the right id by whoever intercepted it, and
 * the whole point of a one-time code is that seeing it once is not enough.
 *
 * This route is server-to-server. It is mounted on the internal face only, so a browser
 * returning from the SaaS cannot reach it and cannot spend the code the Provisioner is
 * about to use (see routes-snapshot.spec.ts).
 */
const verify = (harness: BridgeHarness, body: unknown) => harness.internal('/connections/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' },
  body: JSON.stringify(body),
});

async function consented(): Promise<{ provisioner: BridgeHarness; code: string }> {
  const shared = createFirestoreDouble();
  const bridge = createBridgeHarness({ shared, readTransaction: transactionReader() });
  await seedConnector(bridge);
  const { code } = await completeConsent(bridge);
  const provisioner = createBridgeHarness({ shared, caller: SA.provisioner, readTransaction: transactionReader() });
  return { provisioner, code };
}

describe('verifying a connection', () => {
  it('spends the one_time_code and refuses the second attempt with code_already_used', async () => {
    const { provisioner, code } = await consented();
    expect((await verify(provisioner, { transaction_id: 'tx-1', one_time_code: code })).status).toBe(200);

    const replayed = await verify(provisioner, { transaction_id: 'tx-1', one_time_code: code });
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toEqual({ error: 'code_already_used' });
  });

  it('spends the code even when the transaction id does not match', async () => {
    const { provisioner, code } = await consented();
    const mismatched = await verify(provisioner, { transaction_id: 'tx-somewhere-else', one_time_code: code });
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toEqual({ error: 'code_already_used' });

    // Spent: presenting it again with the right id must not work either.
    const retried = await verify(provisioner, { transaction_id: 'tx-1', one_time_code: code });
    expect(await retried.json()).toEqual({ error: 'code_already_used' });
  });

  it('returns granted_scopes in ascending order', async () => {
    const shared = createFirestoreDouble();
    const bridge = createBridgeHarness({
      shared, readTransaction: transactionReader({ scopes: ['gmail.send', 'calendar.read'] }),
    });
    await seedConnector(bridge);
    const { code } = await completeConsent(bridge);
    const provisioner = createBridgeHarness({
      shared, caller: SA.provisioner,
      readTransaction: transactionReader({ scopes: ['gmail.send', 'calendar.read'] }),
    });

    const response = await verify(provisioner, { transaction_id: 'tx-1', one_time_code: code });
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; granted_scopes: string[] };
    expect(body.status).toBe('READY');
    // Sorted on the way out as well as on the way in, so a caller comparing two
    // answers is comparing sets rather than the order a SaaS happened to reply in.
    expect(body.granted_scopes).toEqual(['calendar.read', 'gmail.send']);
  });

  it('refuses a caller that is not the Provisioner', async () => {
    const { code } = await consented();
    const runtime = createBridgeHarness({ caller: SA.runtime, readTransaction: transactionReader() });
    const response = await verify(runtime, { transaction_id: 'tx-1', one_time_code: code });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_caller' });
  });
});
