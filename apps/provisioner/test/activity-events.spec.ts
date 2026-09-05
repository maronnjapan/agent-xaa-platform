import { describe, expect, it } from 'vitest';
import { validateActivityEvent } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import { ACTIVITY_KINDS, PROVISIONING_EVENT_TYPES } from '../src/events/activity.js';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { provisionAgent } from '../src/provisioning/flow.js';
import { createProvisionerHarness, seedDecision, type ProvisionerHarness } from './helpers.js';

async function provision(target: ProvisionerHarness, capabilities = ['document.read']) {
  await seedDecision(target, { capabilities });
  return provisionAgent({
    ...target.deps,
    logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
    catalogue: createCatalogRepository(target.documents),
  }, {
    humanSubject: 'testuser', taskId: 'task-1', effectiveCapabilities: capabilities,
    isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', hours: 8 },
  });
}

function detail(event: { detail?: unknown }): { event_type: string; activity_kind: string; sequence: number } {
  return event.detail as { event_type: string; activity_kind: string; sequence: number };
}

describe('the Activity Events a provisioning produces', () => {
  it('names each of the eleven event types once, and maps three of them to a kind of their own', () => {
    expect(PROVISIONING_EVENT_TYPES).toHaveLength(11);
    expect(new Set(PROVISIONING_EVENT_TYPES).size).toBe(11);
    expect(ACTIVITY_KINDS['provisioning.idp_consent_required']).toBe('IDP_CONSENT_REQUIRED');
    expect(ACTIVITY_KINDS['provisioning.external_consent_required']).toBe('CONSENT_REQUIRED');
    expect(ACTIVITY_KINDS['agent.active']).toBe('AGENT_PROVISIONED');
    const others = Object.entries(ACTIVITY_KINDS)
      .filter(([type]) => !['provisioning.idp_consent_required', 'provisioning.external_consent_required', 'agent.active'].includes(type));
    expect(others.every(([, kind]) => kind === 'PROVISIONING_STEP')).toBe(true);
  });

  /**
   * The subscriber validates every event against the canonical schema and drops what
   * fails (apps/automation-app/src/activity/subscriber.ts). An event that never reaches
   * a timeline is indistinguishable from one that was never published, which is why
   * this asserts the shape rather than the fact of publishing.
   */
  it('publishes events the subscriber validator accepts', async () => {
    const target = await createProvisionerHarness();
    await provision(target);
    expect(target.activity.length).toBeGreaterThan(0);
    for (const event of target.activity) expect(() => validateActivityEvent(event)).not.toThrow();
  });

  it('walks the provisioning from started to active, numbered in order', async () => {
    const target = await createProvisionerHarness();
    await provision(target);
    expect(target.activity.map((event) => detail(event).event_type)).toEqual([
      'provisioning.started', 'provisioning.idp_connection_created',
      'provisioning.agent_registered', 'provisioning.job_started', 'agent.active',
    ]);
    expect(target.activity.map((event) => detail(event).sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(target.activity.map((event) => event.event_id)).size).toBe(target.activity.length);
  });

  it('puts every provisioning event in the provisioning phase under one task', async () => {
    const target = await createProvisionerHarness();
    await provision(target);
    expect(target.activity.every((event) => event.phase === 'provisioning')).toBe(true);
    expect(target.activity.every((event) => event.task_id === 'provisioning')).toBe(true);
    expect(target.activity.every((event) => event.source === 'provisioner')).toBe(true);
    expect(target.activity.at(-1)!.outcome).toBe('success');
  });

  it('says the consent is needed, and says nothing about an agent that does not exist yet', async () => {
    const target = await createProvisionerHarness({ idpConnectionStatus: 'CONSENT_REQUIRED' });
    const outcome = await provision(target);
    expect(outcome.status).toBe(200);
    const kinds = target.activity.map((event) => detail(event).activity_kind);
    expect(kinds).toEqual(['PROVISIONING_STEP', 'IDP_CONSENT_REQUIRED']);
    expect(kinds).not.toContain('AGENT_PROVISIONED');
  });

  it('continues the numbering after a pause instead of starting again', async () => {
    const target = await createProvisionerHarness({ idpConnectionStatus: 'CONSENT_REQUIRED' });
    await provision(target);
    const paused = (await target.documents.listAll<{ sequence: number }>('provisioning_transactions'))[0]!;
    expect(paused.data.sequence).toBe(2);
    // The resume runs in another process; the count it continues from is the one on
    // the transaction, not one held in this one's memory.
    expect(await target.deps.transactions.nextSequence(paused.id)).toBe(3);
  });

  it('carries no token-shaped string anywhere in a payload', async () => {
    const target = await createProvisionerHarness();
    await provision(target);
    const jwtShape = /"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"/;
    for (const event of target.activity) expect(JSON.stringify(event)).not.toMatch(jwtShape);
  });

  it('redacts a token that reached a detail field rather than publishing it', async () => {
    const target = await createProvisionerHarness();
    const { createActivityEmitter } = await import('../src/events/activity.js');
    await seedDecision(target, { capabilities: ['document.read'] });
    const transaction = await target.deps.transactions.create({
      human_subject: 'testuser', agent_id: null, required_capabilities: [], required_connectors: [],
      isolation_level: 'standard', pending_step: null, dedicated_short_id: null,
      task_id: 'wd-1', constraints: {}, agent_expires_at: '2026-03-01T01:00:00.000Z',
    });
    const published: unknown[] = [];
    await createActivityEmitter({
      transactions: target.deps.transactions,
      logger: createLogger('provisioner', 'provisioner', () => undefined),
      now: () => Date.now(),
      publish: async (event) => { published.push(event); },
    })({
      eventType: 'provisioning.started',
      transactionId: transaction.transaction_id,
      humanSubject: 'testuser',
      agentId: null,
      message: 'ok',
      detail: { leaked: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln' },
    });
    expect(JSON.stringify(published)).toContain('[REDACTED]');
  });
});
