import { expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import {
  AGENT_ID, CALENDAR_READ, INTERNAL_BASE, SA, STUB_CONNECTOR,
  completeConsent, createBridgeHarness, seedConnector, transactionReader,
} from '@xaa/google-bridge/src/testing/harness';
import { createBridgeClient } from '@xaa/provisioner/src/bridge/connection';
import { describeBridge } from '../../support/bridge-enabled.js';

/**
 * The seam between the two services, driven from the Provisioner's own client.
 *
 * Both halves were tested and neither was tested against the other: the Bridge's specs
 * drove its routes from a harness standing in for the Provisioner, and the Provisioner
 * had no client at all — so a deployment with the Bridge on registered an Agent with a
 * bridged Tool, no connection and no binding, and the first SaaS call failed hours
 * later with `invalid_bridge_binding`.
 *
 * This walks the three calls the provisioning steps make, in the order they make them,
 * against the real routes. The Provisioner's own specs use a double for this client;
 * what they cannot check is whether the request bodies and the answers agree, which is
 * exactly what a hand-written client gets wrong.
 */
describeBridge('the Provisioner against the Bridge', () => {
  it('asks for a connection, verifies the consent, and narrows it to a binding', async () => {
    const shared = createFirestoreDouble();
    const bridge = createBridgeHarness({ shared, caller: SA.provisioner, readTransaction: transactionReader() });
    await seedConnector(bridge);

    // The client as the Provisioner builds it, with Cloud Run's edge standing in for
    // the invoker check the harness already makes on the caller's account.
    const client = createBridgeClient({
      baseUrl: INTERNAL_BASE,
      identityToken: async () => 'caller',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        return bridge.internal(`${url.pathname}${url.search}`, init);
      }) as typeof fetch,
    });

    // (1) Nobody has connected this SaaS, so the person has to be sent to consent.
    const first = await client.checkConnection({
      connectorId: STUB_CONNECTOR.connector_id,
      humanSubject: 'testuser',
      requiredScopes: [CALENDAR_READ],
      transactionId: 'tx-1',
    });
    expect(first.status).toBe('CONSENT_REQUIRED');
    if (first.status !== 'CONSENT_REQUIRED') throw new Error('unreachable');
    expect(first.missing_scopes).toEqual([CALENDAR_READ]);
    // The transaction id has to survive the round trip, or the code that comes back
    // belongs to no provisioning anyone can find.
    expect(new URL(first.consent_url).searchParams.get('transaction_id')).toBe('tx-1');

    // (2) The person consents at the SaaS and the browser comes back with a code.
    const { code } = await completeConsent(bridge, { transactionId: 'tx-1' });

    // (3) The code is spent at the Bridge, not here: it was minted into the Bridge's
    // own store, which the Provisioner neither reads nor writes.
    const verified = await client.verifyConnection({ transactionId: 'tx-1', oneTimeCode: code });
    expect(verified.status).toBe('READY');
    expect(verified.granted_scopes).toContain(CALENDAR_READ);

    // (4) On the way back the step runs again and now finds the connection in place.
    const second = await client.checkConnection({
      connectorId: STUB_CONNECTOR.connector_id,
      humanSubject: 'testuser',
      requiredScopes: [CALENDAR_READ],
      transactionId: 'tx-1',
    });
    expect(second.status).toBe('READY');
    if (second.status !== 'READY') throw new Error('unreachable');

    // (5) The agent's own slice of the person's connection, which is what /token reads.
    const bound = await client.createBinding({
      agentId: AGENT_ID,
      connectorId: STUB_CONNECTOR.connector_id,
      connectionId: second.connection_id,
      humanSubject: 'testuser',
      scopes: [CALENDAR_READ],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(bound.binding_id).toBeTruthy();

    const stored = await bridge.documents.get<{ agent_id: string; scopes: string[] }>('agent_bindings', bound.binding_id);
    expect(stored!.agent_id).toBe(AGENT_ID);
    expect(stored!.scopes).toEqual([CALENDAR_READ]);
  });

  /**
   * A second agent for the same person needs no browser: the connection belongs to the
   * person and outlives any one agent (REQ-06-018). The Provisioner's step turns on
   * exactly this answer, so it is checked through the client rather than assumed.
   */
  it('answers READY for a person who has already connected, with no consent url', async () => {
    const shared = createFirestoreDouble();
    const bridge = createBridgeHarness({ shared, caller: SA.provisioner, readTransaction: transactionReader() });
    await seedConnector(bridge);
    await completeConsent(bridge, { transactionId: 'tx-1' });

    const client = createBridgeClient({
      baseUrl: INTERNAL_BASE,
      identityToken: async () => 'caller',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        return bridge.internal(`${url.pathname}${url.search}`, init);
      }) as typeof fetch,
    });

    const checked = await client.checkConnection({
      connectorId: STUB_CONNECTOR.connector_id,
      humanSubject: 'testuser',
      requiredScopes: [CALENDAR_READ],
      transactionId: 'tx-2',
    });
    expect(checked.status).toBe('READY');
    expect(checked).not.toHaveProperty('consent_url');
  });
});
