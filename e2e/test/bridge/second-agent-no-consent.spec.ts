import { expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import {
  completeConsent, createBridgeHarness, seedConnector, transactionReader, SA, STUB_CONNECTOR,
} from '@xaa/google-bridge/src/testing/harness';
import { describeBridge } from '../../support/bridge-enabled.js';
import { guardRedirects } from '../../support/redirect-guard-hook.js';

/**
 * The second agent for the same person, and why nobody's browser opens.
 *
 * REQ-06-018 is a statement about people, not about tokens: a person who has already
 * connected their calendar should not be asked again because a colleague's automation
 * happened to need it too, or because they provisioned a second agent of their own. The
 * connection belongs to the person and the binding belongs to the agent, and this is
 * the test that the two stay separate.
 *
 * The assertion that matters is a negative one — no navigation to the SaaS's
 * `/authorize` — so it is made against the transport rather than against a claim in a
 * response body.
 */
describeBridge('a second agent for the same person', () => {
  it('reaches ACTIVE without a visit to the consent screen', async () => {
    const shared = createFirestoreDouble();
    const first = createBridgeHarness({ shared, readTransaction: transactionReader() });
    await seedConnector(first);
    first.callback = guardRedirects(first.callback);
    first.stubOp.fetch = guardRedirects(first.stubOp.fetch.bind(first.stubOp));
    await completeConsent(first, { transactionId: 'tx-1' });
    const connectionId = (await first.documents.listAll<{ connection_id: string }>('bridge_connections'))[0]!.data.connection_id;

    // The second provisioning starts here: a fresh process, the same person.
    const second = createBridgeHarness({ shared, caller: SA.provisioner, readTransaction: transactionReader() });
    const checked = await second.internal('/connections/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller', 'X-Transaction-Id': 'tx-2' },
      body: JSON.stringify({
        connector_id: STUB_CONNECTOR.connector_id, human_subject: 'testuser', required_scopes: ['calendar.read'],
      }),
    });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ status: 'READY', connection_id: connectionId });

    // READY, so the Provisioner goes straight to the binding.
    const bound = await second.internal('/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' },
      body: JSON.stringify({
        agent_id: 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb', connector_id: STUB_CONNECTOR.connector_id,
        connection_id: connectionId, human_subject: 'testuser',
        scopes: ['calendar.read'], expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(bound.status).toBe(201);
    const binding = await second.documents.get<{ status: string }>(
      'agent_bindings', 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb:stub-saas',
    );
    expect(binding!.status).toBe('ACTIVE');

    // No navigation to the SaaS, and still exactly one connection row.
    expect(second.outbound.filter((url) => url.includes('/authorize'))).toHaveLength(0);
    expect(await second.documents.listAll('bridge_connections')).toHaveLength(1);
  });
});
