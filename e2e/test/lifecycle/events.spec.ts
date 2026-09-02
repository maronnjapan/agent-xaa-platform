import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@xaa/contracts';
import { createLifecycleHarness, recordingClients, seedDomain } from '@xaa/lifecycle-manager/src/testing/harness';

const HOUR = 3_600_000;
const INTERNAL = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

const typeOf = (event: ActivityEvent): string | undefined =>
  (event.detail as { event_type?: string } | undefined)?.event_type;

/**
 * The three lifecycle events, each raised by the route that really causes it.
 *
 * They are asserted together because the property that matters is a count across all
 * three: one event per agent whose life ended, and none for the endings a person
 * already sees from somewhere else. Testing them apart would let two of them fire on
 * the same agent without anything noticing.
 */
describe('what a person sees when an agent ends', () => {
  it('expired, reprovisioned and security-revoked paths each produce one event', async () => {
    const harness = createLifecycleHarness();
    const expired = await seedDomain(harness, {
      agentId: 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa', expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const quarantined = await seedDomain(harness, {
      agentId: 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'QUARANTINED',
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const shrunk = await seedDomain(harness, {
      agentId: 'agent-cccccccccccccccccccccccccc', expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });

    // (1) The deadline, found by the sweep.
    expect((await harness.fetch('/internal/tick', { method: 'POST', headers: INTERNAL })).status).toBe(200);

    // (2) A security decision, arriving from Security Detection.
    const revoked = await harness.fetch(`/internal/agents/${quarantined}/transition`, {
      method: 'POST', headers: INTERNAL, body: JSON.stringify({ to: 'REVOKED', reason: 'QUARANTINE' }),
    });
    expect(revoked.status).toBe(202);

    // (3) A permission change, arriving from the Authorization Platform.
    const reprovisioned = await harness.fetch(`/internal/agents/${shrunk}/reprovision`, {
      method: 'POST', headers: INTERNAL,
      body: JSON.stringify({
        effective_capabilities: ['document.read'], required_capabilities: ['document.read'],
        work_definition_id: 'wd_1',
      }),
    });
    expect(reprovisioned.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const byType = harness.activity.reduce<Record<string, number>>((counts, event) => {
      const type = typeOf(event) ?? 'unknown';
      return { ...counts, [type]: (counts[type] ?? 0) + 1 };
    }, {});
    expect(byType).toEqual({ AGENT_EXPIRED: 1, AGENT_REVOKED_SECURITY: 1, RE_PROVISIONED: 1 });

    // Each carries the fixed values docs 11 gives it, and a deterministic id so a
    // redelivery lands on the document that already exists.
    const expiredEvent = harness.activity.find((event) => typeOf(event) === 'AGENT_EXPIRED')!;
    expect(expiredEvent).toMatchObject({
      agent_id: expired, task_id: 'lifecycle', phase: 'lifecycle', outcome: 'info',
      source: 'lifecycle-manager', is_simulated: false, related_finding_id: null,
      title: '有効期限に達したため終了しました',
    });
    expect(expiredEvent.event_id).toBe(`evt-${expired}-AGENT_EXPIRED`);
    expect(harness.activity.find((event) => typeOf(event) === 'AGENT_REVOKED_SECURITY'))
      .toMatchObject({ agent_id: quarantined, outcome: 'blocked' });
    expect(harness.activity.find((event) => typeOf(event) === 'RE_PROVISIONED')!.detail)
      .toMatchObject({ old_agent_id: shrunk, reason: 'REPROVISION' });

    // Nothing carrying a token shape reached the timeline (RULE-38).
    expect(JSON.stringify(harness.activity)).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./);
  });

  it('emits nothing for a user stop, and nothing while a step is still failing', async () => {
    // The Automation App publishes AGENT_STOPPED for the button the person pressed;
    // a second event from here would put the same act on the timeline twice.
    const stopped = createLifecycleHarness();
    const agentId = await seedDomain(stopped, { expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const moved = await stopped.fetch(`/internal/agents/${agentId}/transition`, {
      method: 'POST', headers: INTERNAL, body: JSON.stringify({ to: 'REVOKED', reason: 'USER_STOP' }),
    });
    expect(moved.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped.activity).toHaveLength(0);

    // And an unfinished cleanup says nothing at all: the agent is not destroyed yet.
    const failing = createLifecycleHarness({ clients: recordingClients({ failAt: 'disableIssuance' }) });
    await seedDomain(failing, { expiresAt: new Date(Date.now() - HOUR).toISOString() });
    expect((await failing.fetch('/internal/tick', { method: 'POST', headers: INTERNAL })).status).toBe(200);
    expect(failing.activity).toHaveLength(0);
  });
});
