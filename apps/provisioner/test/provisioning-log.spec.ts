import { describe, expect, it } from 'vitest';
import { createLogger } from '@xaa/logging';
import { buildProvisioningLog, connectorStates, logProvisioningCompleted, LogContainsToken } from '../src/logging/provisioning-log.js';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { provisionAgent } from '../src/provisioning/flow.js';
import { createProvisionerHarness, seedDecision, seededConnectors, type ProvisionerHarness } from './helpers.js';

const REQUIRED_FIELDS = [
  'agent_id', 'human_subject', 'transaction_id', 'isolation_level', 'dedicated_op', 'dedicated_short_id',
  'provisioned_tools', 'allowed_audiences', 'resources', 'scopes', 'idp_connection_status',
  'connector_states', 'created_at', 'expires_at',
];

function fields(): Parameters<typeof buildProvisioningLog>[0] {
  return {
    agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    human_subject: 'testuser',
    transaction_id: 'txn_aaaaaaaaaaaaaaaaaaaaaa',
    isolation_level: 'standard',
    dedicated_op: false,
    dedicated_short_id: null,
    provisioned_tools: ['internal.document.get'],
    allowed_audiences: ['https://resource-docs-as.test'],
    resources: ['https://resource-docs-api.test'],
    scopes: ['docs.read'],
    idp_connection_status: 'READY',
    connector_states: { 'internal-docs-api': 'READY' },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
}

async function provision(target: ProvisionerHarness, isolationLevel: 'standard' | 'full_isolation') {
  const capabilities = isolationLevel === 'standard' ? ['document.read'] : ['finance.payment.approve'];
  await seedDecision(target, { capabilities, isolationLevel });
  return provisionAgent({
    ...target.deps,
    logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
    catalogue: createCatalogRepository(target.documents),
  }, {
    humanSubject: 'testuser', taskId: 'task-1', effectiveCapabilities: capabilities,
    isolationLevel, constraints: {}, lifetime: { kind: 'requested', hours: 8 },
  });
}

function completionLine(target: ProvisionerHarness): { event: string; fields: Record<string, unknown> } {
  return target.logs.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
    .find((entry) => entry.fields.event === 'provisioning_completed')!;
}

describe('the provisioning completion log', () => {
  it('carries all fourteen fields under one event name', () => {
    const line = buildProvisioningLog(fields());
    expect(line.event).toBe('provisioning_completed');
    for (const field of REQUIRED_FIELDS) expect(line).toHaveProperty(field);
    expect(Object.keys(line)).toHaveLength(REQUIRED_FIELDS.length + 1);
  });

  it('refuses to be written when a value looks like a token, and writes no line at all', () => {
    const lines: string[] = [];
    const logger = createLogger('provisioner', 'provisioner', (line) => { lines.push(line); });
    expect(() => logProvisioningCompleted(logger, buildProvisioningLog({
      ...fields(), provisioned_tools: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln'],
    }))).toThrow(LogContainsToken);
    expect(lines).toEqual([]);
  });

  it('keeps the audiences, resources and scopes at the top level', () => {
    const line = buildProvisioningLog(fields()) as unknown as Record<string, unknown>;
    expect(line.static_xaa).toBeUndefined();
    expect(line.allowed_audiences).toEqual(['https://resource-docs-as.test']);
  });

  it('reports a bridged connector as not connected until a binding exists', () => {
    const states = connectorStates(['internal-docs-api', 'stub-saas-calendar'], seededConnectors());
    expect(states['internal-docs-api']).toBe('READY');
    // The Bridge is off by default (DEC-SCOPE-04); a connector with no binding is not
    // ready, and a log that said otherwise would hide why a tool call later fails.
    if (seededConnectors().some((connector) => connector.connector_id === 'stub-saas-calendar')) {
      expect(states['stub-saas-calendar']).toBe('NOT_CONNECTED');
    }
  });

  it('names the dedicated short id for a FULL_ISOLATION agent', async () => {
    const target = await createProvisionerHarness();
    const outcome = await provision(target, 'full_isolation');
    expect(outcome.status).toBe(201);
    const line = completionLine(target);
    expect(line.fields.dedicated_op).toBe(true);
    expect(line.fields.dedicated_short_id).not.toBe(null);
    expect(line.fields.transaction_id).toBe((outcome.body as { transaction_id: string }).transaction_id);
  });

  it('leaves it null for a STANDARD agent', async () => {
    const target = await createProvisionerHarness();
    await provision(target, 'standard');
    const line = completionLine(target);
    expect(line.fields.dedicated_short_id).toBe(null);
    expect(line.fields.dedicated_op).toBe(false);
    for (const field of REQUIRED_FIELDS) expect(line.fields).toHaveProperty(field);
  });
});
