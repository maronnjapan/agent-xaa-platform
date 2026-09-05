import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PLATFORM_ENDPOINT_KEYS, type PlatformEndpoints } from '@xaa/contracts';
import { resolveSeedPlaceholders } from '../src/resolve.js';
import { validateSeed, type CapabilitySeed, type ConnectorSeed, type HumanPermissionSeed, type ToolSeed } from '../src/validate.js';
import { BRIDGED_CONNECTOR_ID, demoDocuments, demoPayments, withoutBridgedRows } from '../src/index.js';

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

  /**
   * The catalogue's capability names are the ones the Policy Engine decides in
   * (DEC-SCOPE-03). A row naming an alias would give an agent a tool no decision can
   * ever grant — and would do so silently, since nothing else reads that string.
   */
  it('refuses a row whose capability is not one of the settled names', () => {
    expect(() => validateSeed([connector], [{ ...tool, required_capability: 'google.calendar.get' }]))
      .toThrow(/invalid capability/);
    expect(() => validateSeed([connector], [{ ...tool, required_capability: 'document.content.read'.replace('content', 'x') }]))
      .toThrow(/unknown capability/);
  });
});

/**
 * The Job writes nothing until every row has resolved and validated. A partial
 * catalogue is worse than an empty one: the Provisioner would resolve the tools that
 * happened to be written and quietly leave an agent short of the rest.
 */
describe('an unresolved placeholder', () => {
  it('stops the run before anything is written, naming what was not resolved', () => {
    const source = 'audience: ${issuer:docs}\nresource: ${issuer:unknown_service}\n';
    expect(() => resolveSeedPlaceholders(source, endpoints)).toThrow(/unresolved seed placeholders: issuer:unknown_service/);
  });

  it('resolves every placeholder the real catalogue uses', () => {
    for (const kind of ['connectors', 'tools'] as const) {
      expect(JSON.stringify(seeded(kind))).not.toContain('${');
    }
  });
});

/**
 * DEC-SCOPE-04. With the Bridge off, the bridged connector and its tool are left out
 * of Firestore entirely rather than written and marked: the stored shape has no field
 * that would carry "present but unusable" to every reader of the catalogue (00b §3).
 */
describe('the bridged connector when the Bridge is off', () => {
  const rows = () => [
    ...(seeded('connectors') as ConnectorSeed[]),
    ...(seeded('tools') as ToolSeed[]).map((entry) => ({ ...entry })),
  ];

  it('is written when the Bridge is on', () => {
    const kept = withoutBridgedRows(rows(), true);
    expect(kept.filter((row) => row.connector_id === BRIDGED_CONNECTOR_ID).length).toBeGreaterThan(0);
    expect(kept).toHaveLength(rows().length);
  });

  it('is absent when the Bridge is off, and so is its tool', () => {
    const kept = withoutBridgedRows(rows(), false);
    expect(kept.filter((row) => row.connector_id === BRIDGED_CONNECTOR_ID)).toEqual([]);
    expect(kept.map((row) => (row as ToolSeed).tool_id).filter(Boolean)).not.toContain('stub.calendar.events.list');
    // The native connectors and their tools are untouched.
    expect(kept).toHaveLength(rows().length - 2);
  });
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
 * granted, so the demo's people have to arrive with it. The Job clears these
 * collections before it writes; a taxonomy without matching grants would leave every
 * decision intersecting with nothing.
 */
describe('the human permissions in infra/seed', () => {
  const taxonomy = parse(readFileSync(`${seedRoot}capabilities.yaml`, 'utf8')) as CapabilitySeed[];
  const grants = parse(readFileSync(`${seedRoot}human-permissions.yaml`, 'utf8')) as HumanPermissionSeed[];

  it('grants twelve rows, one document per subject and capability', () => {
    expect(grants).toHaveLength(12);
    const ids = grants.map((grant) => `${grant.human_subject}__${grant.capability_id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * `user-123` and `user-456` are subjects of tests and docs examples; the only account
   * a person can actually sign in with is `testuser`. A table that grants nothing to the
   * account the guide names would answer every "必要な権限を調べる" with an empty set, and
   * read on screen as a refusal rather than as data nobody seeded.
   */
  it('grants the account a person signs in with the capabilities the default profile serves', () => {
    const granted = grants.filter((grant) => grant.human_subject === 'testuser').map((grant) => grant.capability_id);
    expect([...granted].sort()).toEqual([
      'document.read', 'document.write', 'finance.payment.approve', 'finance.payment.read',
    ]);
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

/**
 * T-APP-04. The suggestion form reads the person's own documents, and nothing on a
 * freshly applied project has written one, so a broken file here is a demo whose first
 * screen has nothing to suggest from.
 */
describe('the demo documents in infra/seed', () => {
  const rows = parse(readFileSync(`${seedRoot}documents-demo.yaml`, 'utf8')) as unknown;

  it('turns every row into a stored document owned by the person who can sign in', () => {
    const documents = demoDocuments(rows, '2026-01-05T09:00:00.000Z');
    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      expect(document.document_id).toMatch(/^doc_[0-9a-f-]{36}$/);
      expect(document.owner_subject).toBe('testuser');
      expect(document.version).toBe(1);
    }
    // The signal kinds the Automation App reads back (`SIGNAL_KINDS`), not `note`.
    expect(documents.some((document) => document.type === 'daily_report')).toBe(true);
  });

  /** The window the suggestion form opens with is seven days wide. */
  it('places every sample inside the week before the run', () => {
    const createdAt = '2026-01-05T09:00:00.000Z';
    for (const document of demoDocuments(rows, createdAt)) {
      const age = Date.parse(createdAt) - Date.parse(document.occurred_at);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(7 * 86_400_000);
    }
  });

  it('mints the same ids on a second run so re-seeding does not pile up rows', () => {
    const first = demoDocuments(rows).map((document) => document.document_id);
    const second = demoDocuments(rows).map((document) => document.document_id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('refuses a row that tries to set its own id', () => {
    expect(() => demoDocuments([{
      owner_subject: 'testuser', type: 'daily_report', title: 't', body: 'b', occurred_days_ago: 1,
      document_id: 'doc_00000000-0000-0000-0000-000000000000',
    }])).toThrow();
  });
});
