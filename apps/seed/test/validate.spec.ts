import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PLATFORM_ENDPOINT_KEYS, type PlatformEndpoints } from '@xaa/contracts';
import { demoPayments } from '../src/index.js';
import { resolveSeedPlaceholders } from '../src/resolve.js';
import { validateSeed, type CapabilitySeed, type ConnectorSeed, type HumanPermissionSeed, type ToolSeed } from '../src/validate.js';

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

/**
 * REQ-03-019. The naming rule is what keeps vendor names and HTTP verbs out of the
 * permission vocabulary; the Job refuses the whole file rather than writing part of it.
 */
describe('capability naming', () => {
  const bad = parse(`
- capability_id: google.calendar.read
  resource: calendar
- capability_id: document.GET
  resource: document
`) as CapabilitySeed[];

  it('reports every violating capability_id, one per line', () => {
    // The Job's entry point is a top-level await on runSeed, so this throw is what
    // ends the Cloud Run Job with a non-zero exit code.
    try {
      validateSeed([], [], bad);
      expect.unreachable();
    } catch (error) {
      const lines = (error as Error).message.split('\n').filter((line) => line.includes('capability_id'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('google.calendar.read');
      expect(lines[1]).toContain('document.GET');
    }
  });

  it('accepts the taxonomy the deployment actually seeds', () => {
    const taxonomy = parse(readFileSync(`${seedRoot}capabilities.yaml`, 'utf8')) as CapabilitySeed[];
    expect(taxonomy).toHaveLength(8);
    expect(() => validateSeed([], [], taxonomy)).not.toThrow();
  });
});

/**
 * REQ-03-010. The permission table is the ceiling on everything an agent can be
 * granted, so the demo's two people have to arrive with it. The Job clears these
 * collections before it writes; a taxonomy without matching grants would leave every
 * decision intersecting with nothing.
 */
describe('the human permissions in infra/seed', () => {
  const taxonomy = parse(readFileSync(`${seedRoot}capabilities.yaml`, 'utf8')) as CapabilitySeed[];
  const grants = parse(readFileSync(`${seedRoot}human-permissions.yaml`, 'utf8')) as HumanPermissionSeed[];

  it('grants eight rows, one document per subject and capability', () => {
    expect(grants).toHaveLength(8);
    const ids = grants.map((grant) => `${grant.human_subject}__${grant.capability_id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('grants only capabilities the taxonomy defines', () => {
    expect(() => validateSeed([], [], taxonomy, grants)).not.toThrow();
    expect(() => validateSeed([], [], taxonomy, [{ human_subject: 'user-123', capability_id: 'slack.channel.admin' }]))
      .toThrow(/slack.channel.admin/);
  });
});

/**
 * T-RES-16. The demo payments are the only rows the Finance API cannot create for
 * itself, so a broken file here is a demo with nothing to approve.
 */
describe('the demo payments in infra/seed', () => {
  const rows = parse(readFileSync(`${seedRoot}payments-demo.yaml`, 'utf8')) as unknown;

  it('turns every row into a pending_approval payment', () => {
    const payments = demoPayments(rows, '2026-01-05T09:00:00.000Z');
    expect(payments.length).toBeGreaterThan(0);
    for (const payment of payments) {
      expect(payment.status).toBe('pending_approval');
      expect(payment.payment_id).toMatch(/^pay_[0-9a-f-]{36}$/);
      expect(payment.approved_by).toBeNull();
      expect(payment.approved_by_agent).toBeNull();
      expect(payment.approved_at).toBeNull();
    }
  });

  it('mints the same ids on a second run so re-seeding does not pile up rows', () => {
    const first = demoPayments(rows).map((payment) => payment.payment_id);
    const second = demoPayments(rows).map((payment) => payment.payment_id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('refuses a row that tries to set its own approver', () => {
    expect(() => demoPayments([{
      requester_subject: 'testuser', amount: 1, currency: 'JPY', counterparty: 'c', memo: 'm',
      approved_by: 'someone',
    }])).toThrow();
  });
});
