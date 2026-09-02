import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import {
  AGENT_ID, SA, STUB_CONNECTOR, createBridgeHarness, seedConnection, seedConnector,
  testConfig, type BridgeHarness,
} from '../src/testing/harness.js';
import { connectionId } from '../src/store/connection.js';
import { createInternalApp } from '../src/index.js';
import { createFirestoreDocumentStore } from '@xaa/gcp';
import { InMemoryJtiStore } from '@xaa/crypto';

/**
 * Creating, disabling and deleting an Agent Binding.
 *
 * The four checks on creation each get their own reason code. Collapsing them into one
 * `invalid_request` would leave the Provisioner unable to tell "this person never
 * granted that scope" from "you asked for a lifetime longer than an agent may have",
 * and those need different fixes by different people.
 *
 * Disable and delete answer 204 for a binding that was never there. Cleanup retries,
 * and "already gone" is the outcome it wanted: an error would make the Lifecycle
 * Manager record a failed step for work that is in fact complete.
 */
const body = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  agent_id: AGENT_ID,
  connector_id: STUB_CONNECTOR.connector_id,
  connection_id: connectionId(STUB_CONNECTOR.connector_id, 'testuser'),
  human_subject: 'testuser',
  scopes: ['calendar.read'],
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  ...overrides,
});

const post = (harness: BridgeHarness, payload: string) => harness.internal('/bindings', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' }, body: payload,
});

async function provisionerHarness(): Promise<BridgeHarness> {
  const harness = createBridgeHarness({ caller: SA.provisioner });
  await seedConnector(harness);
  await seedConnection(harness, { grantedScopes: ['calendar.read'] });
  return harness;
}

describe('the bindings API', () => {
  it('creates a binding and answers 201 with the id and the expiry', async () => {
    const harness = await provisionerHarness();
    const created = await post(harness, body());
    expect(created.status).toBe(201);
    // Two keys, and neither of them is `scopes`: what the binding may do is the
    // Bridge's business, and echoing it invites a caller to trust its own copy.
    expect(Object.keys(await created.json() as object).sort()).toEqual(['binding_id', 'expires_at']);
  });

  it('refuses scopes the connection never granted', async () => {
    const harness = await provisionerHarness();
    const response = await post(harness, body({ scopes: ['calendar.read', 'gmail.send'] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'scope_not_in_connection' });
  });

  it('refuses a human_subject the connection does not belong to', async () => {
    const harness = await provisionerHarness();
    const response = await post(harness, body({ human_subject: 'someone-else' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'human_subject_mismatch' });
  });

  it('refuses an expiry more than 24h away', async () => {
    const harness = await provisionerHarness();
    const response = await post(harness, body({ expires_at: new Date(Date.now() + 172_800_000).toISOString() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'expires_at_too_far' });
  });

  it('refuses a duplicate binding for the same agent and connector', async () => {
    const harness = await provisionerHarness();
    expect((await post(harness, body())).status).toBe(201);
    const again = await post(harness, body());
    expect(again.status).toBe(400);
    // `create`, not `set`: a second binding would otherwise silently replace the first
    // one's scopes with whatever this call asked for.
    expect(await again.json()).toEqual({ error: 'binding_already_exists' });
  });

  it('disables idempotently', async () => {
    const harness = createBridgeHarness({ caller: SA.lifecycle });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await harness.internal(`/bindings/${AGENT_ID}/disable`, {
        method: 'POST', headers: { Authorization: 'Bearer caller' },
      })).status).toBe(204);
    }
  });

  it('deletes idempotently', async () => {
    const harness = createBridgeHarness({ caller: SA.lifecycle });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await harness.internal(`/bindings/${AGENT_ID}`, {
        method: 'DELETE', headers: { Authorization: 'Bearer caller' },
      })).status).toBe(204);
    }
  });
});

describe('the binding lifecycle', () => {
  it('removes one agent\'s rows and leaves the connection and the other agent alone', async () => {
    const shared = createFirestoreDouble();
    const provisioner = createBridgeHarness({ caller: SA.provisioner, shared });
    await seedConnector(provisioner);
    await seedConnection(provisioner, { grantedScopes: ['calendar.read'] });
    const second = 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect((await post(provisioner, body())).status).toBe(201);
    expect((await post(provisioner, body({ agent_id: second }))).status).toBe(201);

    // The Provisioner may create a binding but not remove one (RULE-36).
    expect((await provisioner.internal(`/bindings/${AGENT_ID}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer caller' },
    })).status).toBe(403);
    expect(await (await provisioner.internal(`/bindings/${AGENT_ID}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer caller' },
    })).json()).toEqual({ error: 'forbidden_caller' });

    const lifecycle = createBridgeHarness({ caller: SA.lifecycle, shared });
    expect((await lifecycle.internal(`/bindings/${AGENT_ID}/disable`, {
      method: 'POST', headers: { Authorization: 'Bearer caller' },
    })).status).toBe(204);
    expect((await lifecycle.internal(`/bindings/${AGENT_ID}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer caller' },
    })).status).toBe(204);

    const rows = await lifecycle.documents.listAll<{ agent_id: string }>('agent_bindings');
    expect(rows.map((row) => row.data.agent_id)).toEqual([second]);
    // The connection is the person's, not the agent's, and survives the agent.
    expect(await lifecycle.documents.listAll('bridge_connections')).toHaveLength(1);
  });

  it('caps the expiry at AGENT_MAX_LIFETIME_SECONDS when that is shorter than 24h', async () => {
    // min(86400, AGENT_MAX_LIFETIME_SECONDS): an hour-long agent may not hold a
    // binding that outlives it by a day.
    const shared = createFirestoreDouble();
    const harness = createBridgeHarness({ caller: SA.provisioner, shared });
    await seedConnector(harness);
    await seedConnection(harness, { grantedScopes: ['calendar.read'] });

    const documents = createFirestoreDocumentStore(shared, 'google-bridge');
    const app = createInternalApp({
      config: { ...testConfig, agentMaxLifetimeSeconds: 3600 },
      documents,
      jtiStore: new InMemoryJtiStore(),
      kms: {
        async encrypt(_keyName, plaintext) { return plaintext; },
        async decrypt(_keyName, ciphertext) { return ciphertext; },
      },
      readSecret: async () => 'secret',
      callerVerify: async () => SA.provisioner,
    });
    const response = await app.fetch(new Request('https://google-bridge.test/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' },
      body: body({ expires_at: new Date(Date.now() + 7_200_000).toISOString() }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'expires_at_too_far' });
  });
});
