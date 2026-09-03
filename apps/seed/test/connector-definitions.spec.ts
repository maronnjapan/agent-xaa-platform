import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PLATFORM_ENDPOINT_KEYS, type PlatformEndpoints } from '@xaa/contracts';
import {
  BRIDGED_CONNECTOR_ID, GOOGLE_CONNECTOR_ID, STUB_BRIDGE_CLIENT_ID, bridgeConnectorDefinitions,
} from '../src/connector-definitions.js';
import { resolveSeedPlaceholders } from '../src/resolve.js';

const seedRoot = new URL('../../../infra/seed/', import.meta.url).pathname;

const endpoints = Object.fromEntries(PLATFORM_ENDPOINT_KEYS.map((key) => [
  key,
  key === 'agent_max_lifetime_seconds' ? 3600
    : key === 'enable_google_bridge' ? true
    : key === 'vertex_model' || key === 'vertex_location' ? 'test'
    : `https://${key.replaceAll('_', '-')}.test`,
])) as unknown as PlatformEndpoints;

/** The keys the Bridge's schema requires, with additionalProperties: false. */
const BRIDGE_KEYS = [
  'connector_id', 'display_name', 'authorization_endpoint', 'token_endpoint',
  'revocation_endpoint', 'userinfo_endpoint', 'client_id', 'secret_name',
  'default_scopes', 'subject_claim', 'connection_max_age_seconds', 'resource_uris',
].sort();

const stubEnv = {
  PROJECT_ID: 'xaa-demo', ENABLE_GOOGLE_BRIDGE: 'true', SAAS_CONNECTOR_MODE: 'stub',
  STUB_BRIDGE_SECRET_ID: 'stub-bridge-client-secret', GOOGLE_OAUTH_SECRET_ID: 'google-oauth-client-secret',
};

describe('connector definitions the seed writes for the Bridge', () => {
  it('writes nothing while the Bridge is off', () => {
    expect(bridgeConnectorDefinitions({ ...stubEnv, ENABLE_GOOGLE_BRIDGE: 'false' }, endpoints)).toEqual([]);
  });

  it('stub mode: one row that points at the deployed stub and names its secret', () => {
    const rows = bridgeConnectorDefinitions(stubEnv, endpoints);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual(BRIDGE_KEYS);
    expect(row.connector_id).toBe(BRIDGED_CONNECTOR_ID);
    expect(row.client_id).toBe(STUB_BRIDGE_CLIENT_ID);
    expect(row.secret_name).toBe('projects/xaa-demo/secrets/stub-bridge-client-secret');
    expect(row.authorization_endpoint).toBe('https://stub-saas-op-issuer.test/authorize');
    expect(row.token_endpoint).toBe('https://stub-saas-op-issuer.test/token');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'userinfo_endpoint'] as const) {
      expect(row[key]).toMatch(/^https:\/\//);
    }
    expect(row.connection_max_age_seconds).toBeGreaterThanOrEqual(60);
    expect(row.resource_uris.length).toBeGreaterThan(0);
  });

  it('stub mode: resource_uris is exactly the resource the stub calendar tool presents', () => {
    const tool = parse(resolveSeedPlaceholders(
      readFileSync(`${seedRoot}tools/stub.calendar.events.list.yaml`, 'utf8'), endpoints,
    )) as { connector_id: string; authorization: { resource: string; scope: string } };
    const [row] = bridgeConnectorDefinitions(stubEnv, endpoints);
    expect(tool.connector_id).toBe(row!.connector_id);
    expect(row!.resource_uris).toEqual([tool.authorization.resource]);
    expect(row!.default_scopes).toContain(tool.authorization.scope);
  });

  it('google mode: the Google client id goes into the row, never a secret value', () => {
    const [row] = bridgeConnectorDefinitions(
      { ...stubEnv, SAAS_CONNECTOR_MODE: 'google', GOOGLE_OAUTH_CLIENT_ID: '123.apps.googleusercontent.com' }, endpoints,
    );
    expect(row!.connector_id).toBe(GOOGLE_CONNECTOR_ID);
    expect(Object.keys(row!).sort()).toEqual(BRIDGE_KEYS);
    expect(row!.client_id).toBe('123.apps.googleusercontent.com');
    expect(row!.secret_name).toBe('projects/xaa-demo/secrets/google-oauth-client-secret');
    expect(JSON.stringify(row)).not.toMatch(/client_secret/);
  });

  it('google mode without a client id is refused before anything is written', () => {
    expect(() => bridgeConnectorDefinitions({ ...stubEnv, SAAS_CONNECTOR_MODE: 'google' }, endpoints))
      .toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it('an unknown connector mode is refused', () => {
    expect(() => bridgeConnectorDefinitions({ ...stubEnv, SAAS_CONNECTOR_MODE: 'other' }, endpoints)).toThrow(/SAAS_CONNECTOR_MODE/);
  });
});
