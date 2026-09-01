import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { sweep } from '../src/sweep.js';
import { quarantine } from '../src/quarantine.js';
import { cleanupAgent } from '../src/cleanup/index.js';
import { handleIdentityDisabled, REVOCABLE_STATUSES } from '../src/subscribers/identity-disabled.js';
import { createIdentityDisabledHandler, startIdentityDisabledSubscriber } from '../src/subscribers/runner.js';
import { AGENT_STATUSES } from '../src/state-machine.js';
import { createLifecycleHarness, recordingClients, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };
const HOUR = 3_600_000;

function cleanupFor(harness: LifecycleHarness) {
  return (agentId: string, reason: Parameters<typeof cleanupAgent>[1]) =>
    cleanupAgent(agentId, reason, { documents: harness.documents, clients: harness.clients, logger, logContext });
}

describe('the sweep', () => {
  it('moves ACTIVE to EXPIRING inside the window', async () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const harness = createLifecycleHarness({ now: () => now });
    const agentId = await seedDomain(harness, { expiresAt: new Date(now + 30_000).toISOString() });
    const counters = await sweep({
      documents: harness.documents, expiringWindowSeconds: 60, now: () => now, cleanup: cleanupFor(harness),
    });
    expect(counters.expiring).toBe(1);
    expect((await harness.documents.get<{ status: string }>('agents', `${agentId}__meta`))!.status).toBe('EXPIRING');
    expect(harness.clients.calls).toHaveLength(0);
  });

  it('takes an expired agent to DESTROYED in a single tick', async () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const harness = createLifecycleHarness({ now: () => now });
    const agentId = await seedDomain(harness, { expiresAt: new Date(now - HOUR).toISOString() });
    const counters = await sweep({
      documents: harness.documents, expiringWindowSeconds: 60, now: () => now, cleanup: cleanupFor(harness),
    });
    expect(counters.expired).toBe(1);
    // The record is gone, which is the strongest statement that cleanup finished.
    expect(await harness.documents.get('agents', `${agentId}__meta`)).toBeUndefined();
  });

  it('retries only failed steps and keeps the original reason', async () => {
    const shared = createFirestoreDouble();
    const failing = createLifecycleHarness({ shared, clients: recordingClients({ failAt: 'disableIssuance' }) });
    const agentId = await seedDomain(failing, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    await cleanupFor(failing)(agentId, 'QUARANTINE');

    const healthy = createLifecycleHarness({ shared });
    const counters = await sweep({
      documents: healthy.documents, expiringWindowSeconds: 60, cleanup: cleanupFor(healthy),
    });
    expect(counters.retried).toBe(1);
    expect(healthy.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(0);
    expect(healthy.clients.calls.filter((entry) => entry.target === 'disableIssuance')).toHaveLength(1);
  });

  it('abandons stale provisioning transactions', async () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const harness = createLifecycleHarness({ now: () => now });
    await harness.documents.set('provisioning_transactions', 'tx-1', {
      status: 'WAITING_IDP_CONSENT', created_at: new Date(now - 2 * HOUR).toISOString(), human_subject: 'testuser',
    });
    await harness.documents.set('provisioning_transactions', 'tx-2', {
      status: 'WAITING_IDP_CONSENT', created_at: new Date(now - 60_000).toISOString(), human_subject: 'testuser',
    });
    const counters = await sweep({
      documents: harness.documents, expiringWindowSeconds: 60, now: () => now, cleanup: cleanupFor(harness),
    });
    expect(counters.abandoned).toBe(1);
    expect((await harness.documents.get<{ status: string }>('provisioning_transactions', 'tx-1'))!.status).toBe('ABANDONED');
    expect((await harness.documents.get<{ status: string }>('provisioning_transactions', 'tx-2'))!.status).toBe('WAITING_IDP_CONSENT');
  });

  it('deletes a labelled resource whose agent no longer exists, and leaves the rest', async () => {
    const harness = createLifecycleHarness({
      labelled: [
        { name: 'dedicated-op-orphanabcdef', kind: 'cloud_run_service', agentId: 'agent-gonegonegonegonegonegone' },
        { name: 'dedicated-op-liveagentabc', kind: 'cloud_run_service', agentId: 'agent-abcdefghijklmnopqrstuvwxyz' },
        { name: 'dedicated-op-unlabelledxx', kind: 'cloud_run_service', agentId: null },
      ],
    });
    await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const counters = await sweep({
      documents: harness.documents, expiringWindowSeconds: 60, cleanup: cleanupFor(harness),
      ...harness.deps.sweepExtras!,
    });
    expect(counters.orphans_deleted).toBe(1);
    expect(harness.deletedResources.map((resource) => resource.name)).toEqual(['dedicated-op-orphanabcdef']);
  });

  it('refuses to delete a labelled resource outside the runtime name space', async () => {
    const harness = createLifecycleHarness({
      labelled: [{ name: 'human-idp', kind: 'cloud_run_service', agentId: 'agent-gonegonegonegonegonegone' }],
    });
    await expect(sweep({
      documents: harness.documents, expiringWindowSeconds: 60, cleanup: cleanupFor(harness),
      ...harness.deps.sweepExtras!,
    })).rejects.toThrow(/runtime name space/);
    expect(harness.deletedResources).toHaveLength(0);
  });
});

describe('the tick endpoint', () => {
  it('rejects an unknown caller', async () => {
    const harness = createLifecycleHarness({
      allowedCallers: ['sa-scheduler@xaa-test.iam.gserviceaccount.com'],
      callerEmail: 'sa-other@xaa-test.iam.gserviceaccount.com',
    });
    const response = await harness.fetch('/internal/tick', {
      method: 'POST', headers: { Authorization: 'Bearer token' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'caller_not_allowed' });
  });

  it('rejects a caller whose email merely starts with an allowed one', async () => {
    const harness = createLifecycleHarness({
      allowedCallers: ['sa-scheduler@xaa-test.iam.gserviceaccount.com'],
      callerEmail: 'sa-scheduler@xaa-test.iam.gserviceaccount.com.attacker.example',
    });
    const response = await harness.fetch('/internal/tick', {
      method: 'POST', headers: { Authorization: 'Bearer token' },
    });
    expect(response.status).toBe(403);
  });

  it('rejects a request with no token at all', async () => {
    const harness = createLifecycleHarness();
    expect((await harness.fetch('/internal/tick', { method: 'POST' })).status).toBe(403);
  });

  it('answers with the six counters', async () => {
    const harness = createLifecycleHarness();
    const response = await harness.fetch('/internal/tick', {
      method: 'POST', headers: { Authorization: 'Bearer token' },
    });
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json() as object).sort())
      .toEqual(['abandoned', 'expired', 'expiring', 'orphans_deleted', 'retried', 'scanned']);
  });
});

describe('quarantine', () => {
  it('disables issuance and bindings but never cancels the execution', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ bridgeUrl: 'https://bridge.test' }) });
    const agentId = await seedDomain(harness, { bridgeBindingIds: ['bind-1'] });
    await quarantine({
      documents: harness.documents, clients: harness.clients, agentId,
      bridgeBindingIds: ['bind-1'], severity: 'CRITICAL',
    });
    expect(harness.clients.calls.map((entry) => entry.target)).toEqual(['disableIssuance', 'disableBindings']);
    // The process keeps running and keeps writing its checkpoint: evidence, not mercy.
    expect(harness.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(0);
    expect((await harness.documents.get<{ status: string }>('agents', `${agentId}__meta`))!.status).toBe('QUARANTINED');
  });

  it('accepts ACTIVE to QUARANTINED with severity CRITICAL and refuses it without', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    const withSeverity = await harness.fetch(`/internal/agents/${agentId}/transition`, {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'QUARANTINED', severity: 'CRITICAL', reason: 'QUARANTINE' }),
    });
    expect(withSeverity.status).toBe(202);

    const second = createLifecycleHarness();
    const other = await seedDomain(second);
    const withoutSeverity = await second.fetch(`/internal/agents/${other}/transition`, {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'QUARANTINED', reason: 'QUARANTINE' }),
    });
    expect(withoutSeverity.status).toBe(409);
    expect(await withoutSeverity.json()).toEqual({ error: 'invalid_transition' });
  });

  it('cancels the execution only after the REVOKED transition', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await harness.fetch(`/internal/agents/${agentId}/transition`, {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'SUSPICIOUS', reason: 'QUARANTINE' }),
    });
    expect(harness.clients.calls).toHaveLength(0);

    await harness.fetch(`/internal/agents/${agentId}/transition`, {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'QUARANTINED', reason: 'QUARANTINE' }),
    });
    expect(harness.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(0);

    await harness.fetch(`/internal/agents/${agentId}/transition`, {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'REVOKED', reason: 'QUARANTINE' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(1);
  });

  it('rejects a transition body with an extra field', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    const response = await harness.fetch(`/internal/agents/${agentId}/transition`, {
      method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'SUSPICIOUS', reason: 'QUARANTINE', human_subject: 'someone-else' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('a disabled human identity', () => {
  it('revokes the six eligible statuses and skips the terminal three', async () => {
    const harness = createLifecycleHarness();
    for (const [index, status] of AGENT_STATUSES.entries()) {
      await seedDomain(harness, {
        agentId: `agent-${'abcdefghijklmnopqrstuvwxyz'.slice(0, 25)}${index}`,
        status, expiresAt: new Date(Date.now() + HOUR).toISOString(),
      });
    }
    const result = await handleIdentityDisabled({
      message: { human_subject: 'testuser', disabled_at: '2026-01-01T00:00:00.000Z' },
      documents: harness.documents, logger, logContext, cleanup: cleanupFor(harness) as never,
    });
    expect(result.revoked).toHaveLength(REVOCABLE_STATUSES.length);
    expect(REVOCABLE_STATUSES).toHaveLength(6);
  });

  it('continues with the remaining agents when one cleanup throws', async () => {
    const harness = createLifecycleHarness();
    const ids = ['agent-aaaaaaaaaaaaaaaaaaaaaaaaaa', 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb', 'agent-cccccccccccccccccccccccccc'];
    for (const agentId of ids) await seedDomain(harness, { agentId, expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const result = await handleIdentityDisabled({
      message: { human_subject: 'testuser', disabled_at: '2026-01-01T00:00:00.000Z' },
      documents: harness.documents, logger, logContext,
      cleanup: async (agentId) => {
        if (agentId === ids[1]) throw new Error('agent op unreachable');
        return cleanupFor(harness)(agentId, 'IDENTITY_DISABLED');
      },
    });
    expect(result.revoked.sort()).toEqual([ids[0], ids[2]]);
    expect(result.failed).toEqual([ids[1]]);
  });

  it('abandons in-flight provisioning transactions first', async () => {
    const harness = createLifecycleHarness();
    await harness.documents.set('provisioning_transactions', 'tx-1', { status: 'IN_PROGRESS', human_subject: 'testuser', created_at: '2026-01-01T00:00:00.000Z' });
    await harness.documents.set('provisioning_transactions', 'tx-2', { status: 'COMPLETED', human_subject: 'testuser', created_at: '2026-01-01T00:00:00.000Z' });
    const result = await handleIdentityDisabled({
      message: { human_subject: 'testuser', disabled_at: '2026-01-01T00:00:00.000Z' },
      documents: harness.documents, logger, logContext, cleanup: cleanupFor(harness) as never,
    });
    expect(result.abandoned).toBe(1);
    expect((await harness.documents.get<{ status: string }>('provisioning_transactions', 'tx-1'))!.status).toBe('ABANDONED');
  });

  it('acks and logs an invalid message without acting', async () => {
    const lines: string[] = [];
    const harness = createLifecycleHarness();
    const result = await handleIdentityDisabled({
      message: { human_subject: 'testuser' },
      documents: harness.documents,
      logger: createLogger('lifecycle-manager', 'provisioner', (line) => lines.push(line)),
      logContext, cleanup: cleanupFor(harness) as never,
    });
    expect(result).toEqual({ revoked: [], failed: [], abandoned: 0 });
    expect(lines.some((line) => line.includes('invalid_identity_disabled_event'))).toBe(true);
  });
});

/**
 * The handler existed long before anything called it. These fix the wiring itself: a
 * delivered message must reach `handleIdentityDisabled`, and every message must be
 * acked, because redelivery would re-run cleanup for the agents already settled.
 */
describe('the identity-disabled subscriber', () => {
  function delivery() {
    const acked: string[] = [];
    let listener: ((message: { data: Buffer; ack(): void; nack(): void }) => void) | undefined;
    return {
      acked,
      subscription: { on: (_event: 'message', handler: (message: { data: Buffer; ack(): void; nack(): void }) => void) => { listener = handler; } },
      send: (raw: string) => listener!({
        data: Buffer.from(raw),
        ack: () => acked.push('ack'),
        nack: () => acked.push('nack'),
      }),
    };
  }

  async function settled(harness: LifecycleHarness, cleaned: Array<[string, string]>) {
    const { acked, subscription, send } = delivery();
    startIdentityDisabledSubscriber(subscription, createIdentityDisabledHandler({
      documents: harness.documents,
      logger,
      cleanup: async (agentId, reason) => {
        cleaned.push([agentId, reason]);
        return { status: 'DESTROYED', steps: [] } as never;
      },
    }));
    return { acked, send };
  }

  it('takes a delivered message to the cleanup of that person\'s agents', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const cleaned: Array<[string, string]> = [];
    const { acked, send } = await settled(harness, cleaned);

    send(JSON.stringify({ human_subject: 'testuser', disabled_at: '2026-01-01T00:00:00.000Z' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cleaned).toEqual([[agentId, 'IDENTITY_DISABLED']]);
    expect(acked).toEqual(['ack']);
  });

  it('acks a message it cannot parse rather than letting it come back', async () => {
    const harness = createLifecycleHarness();
    const cleaned: Array<[string, string]> = [];
    const { acked, send } = await settled(harness, cleaned);

    send('not json');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cleaned).toEqual([]);
    expect(acked).toEqual(['ack']);
  });
});
