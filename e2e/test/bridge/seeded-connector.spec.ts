import { expect, it } from 'vitest';
import { PLATFORM_ENDPOINT_KEYS, compile, type PlatformEndpoints } from '@xaa/contracts';
import { connectorDefinitionSchema, type ConnectorDefinition } from '@xaa/google-bridge/src/connectors/types';
import {
  createBridgeHarness, transactionReader, STUB_CONNECTOR, STUB_OP_BASE,
} from '@xaa/google-bridge/src/testing/harness';
import { bridgeConnectorDefinitions } from 'seed/src/connector-definitions';
import { describeBridge } from '../../support/bridge-enabled.js';
import { guardRedirects } from '../../support/redirect-guard-hook.js';

/** What Terraform writes to platform-endpoints.json for a Bridge deployment pointed at the stub. */
const endpoints = Object.fromEntries(PLATFORM_ENDPOINT_KEYS.map((key) => [
  key,
  key === 'agent_max_lifetime_seconds' ? 3600
    : key === 'enable_google_bridge' ? true
    : key === 'vertex_model' || key === 'vertex_location' ? 'test'
    : key === 'stub_saas_op_issuer' ? STUB_OP_BASE
    : `https://${key.replaceAll('_', '-')}.test`,
])) as unknown as PlatformEndpoints;

const jobEnv = {
  PROJECT_ID: 'xaa-test', ENABLE_GOOGLE_BRIDGE: 'true',
  STUB_BRIDGE_SECRET_ID: 'stub-bridge-client-secret', GOOGLE_OAUTH_SECRET_ID: 'google-oauth-client-secret',
};

const assertConnector: (value: unknown) => asserts value is ConnectorDefinition =
  compile<ConnectorDefinition>(connectorDefinitionSchema);

/**
 * The seed Job is the only writer of `connector_definitions` (00b §3), and the Bridge
 * refuses any row its schema does not accept with `invalid_target`. The two sides are
 * held together here: the rows the Job writes for both connector modes pass the
 * Bridge's own validator, and the stub row is enough for a consent to start.
 */
describeBridge('the connector definitions the seed writes', () => {
  it('pass the Bridge schema in both connector modes', () => {
    for (const mode of ['stub', 'google']) {
      const rows = bridgeConnectorDefinitions(
        { ...jobEnv, SAAS_CONNECTOR_MODE: mode, GOOGLE_OAUTH_CLIENT_ID: '1.apps.googleusercontent.com' }, endpoints,
      );
      expect(rows).toHaveLength(1);
      expect(() => assertConnector(rows[0])).not.toThrow();
    }
  });

  it('stub mode: the seeded row lets a consent start and reach the stub, using its client', async () => {
    const [row] = bridgeConnectorDefinitions({ ...jobEnv, SAAS_CONNECTOR_MODE: 'stub' }, endpoints);
    const bridge = createBridgeHarness({ readTransaction: transactionReader() });
    await bridge.seedStore.set('connector_definitions', row!.connector_id, row as unknown as Record<string, unknown>);
    bridge.callback = guardRedirects(bridge.callback);

    const started = await bridge.callback(`/${row!.connector_id}/oauth/start?transaction_id=tx-1`, { redirect: 'manual' });
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get('location')!);
    expect(authorize.origin).toBe(STUB_OP_BASE);
    expect(authorize.searchParams.get('client_id')).toBe(STUB_CONNECTOR.client_id);

    // The stub answers this client with a code, so the row names the client it accepts.
    const authorized = await bridge.stubOp.fetch(new Request(authorize.toString(), { redirect: 'manual' }));
    expect(authorized.status).toBe(302);
    expect(new URL(authorized.headers.get('location')!).searchParams.get('code')).toBeTruthy();
  });
});
