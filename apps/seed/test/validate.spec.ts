import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PLATFORM_ENDPOINT_KEYS, type PlatformEndpoints } from '@xaa/contracts';
import { resolveSeedPlaceholders } from '../src/resolve.js';
import { validateSeed, type ConnectorSeed, type ToolSeed } from '../src/validate.js';

const seedRoot = new URL('../../../infra/seed/', import.meta.url).pathname;

/** Every key Terraform writes, filled with a distinguishable value. */
const endpoints = Object.fromEntries(PLATFORM_ENDPOINT_KEYS.map((key) => [
  key,
  key === 'agent_max_lifetime_seconds' ? 3600
    : key === 'enable_google_bridge' ? true
    : key === 'vertex_model' || key === 'vertex_location' ? 'test'
    : `https://${key.replaceAll('_', '-')}.test`,
])) as unknown as PlatformEndpoints;

function seeded(kind: 'connectors' | 'tools') {
  return readdirSync(`${seedRoot}${kind}`)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => parse(resolveSeedPlaceholders(readFileSync(`${seedRoot}${kind}/${name}`, 'utf8'), endpoints)));
}

const connector: ConnectorSeed = {
  connector_id: 'internal-docs-api',
  resource_type: 'native_xaa',
  authorization_audience: 'https://as.example',
  authorization_resource: 'https://api.example',
  status: 'ACTIVE',
  risk_level: 'medium',
  tools: ['internal.document.get'],
};
const tool: ToolSeed = {
  tool_id: 'internal.document.get',
  connector_id: 'internal-docs-api',
  description: 'Get a document',
  required_capability: 'document.read',
  authorization: { type: 'native_xaa', audience: 'https://as.example', resource: 'https://api.example', scope: 'docs.read' },
  token_provider: null,
  api: { base_url: 'https://api.example', method: 'GET', path: '/documents/{id}' },
  parameters: { id: {} },
  constraints: {},
  response_schema: { type: 'object' },
  risk_level: 'low',
};

describe('seed validation', () => {
  it('accepts a valid connector and tool', () => expect(() => validateSeed([connector], [tool])).not.toThrow());
  it('rejects native_xaa connector without authorization.resource', () => expect(() => validateSeed([{ ...connector, authorization_resource: undefined }], [tool])).toThrow(/authorization_resource/));
  it('rejects unknown resource_type', () => expect(() => validateSeed([{ ...connector, resource_type: 'unknown' as 'native_xaa' }], [tool])).toThrow(/resource_type/));
  it('rejects api.method FETCH', () => expect(() => validateSeed([connector], [{ ...tool, api: { ...tool.api, method: 'FETCH' } }])).toThrow(/api.method/));
  it('rejects path placeholder missing from parameters', () => expect(() => validateSeed([connector], [{ ...tool, parameters: {} }])).toThrow(/missing parameter id/));
});

/**
 * The seed job reads these very files. Checking a hand-written fixture instead would
 * pass while the real catalogue names a placeholder the resolver has never heard of,
 * which is a Job that fails on every run and a Firestore that stays empty.
 */
describe('the catalogue in infra/seed', () => {
  it('resolves with the documented placeholders alone', () => {
    expect(() => seeded('connectors')).not.toThrow();
    expect(() => seeded('tools')).not.toThrow();
  });

  it('passes the same validation the Job runs', () => {
    const connectors = seeded('connectors') as ConnectorSeed[];
    const tools = seeded('tools') as ToolSeed[];
    expect(connectors).toHaveLength(3);
    expect(tools).toHaveLength(8);
    expect(() => validateSeed(connectors, tools)).not.toThrow();
  });
});
