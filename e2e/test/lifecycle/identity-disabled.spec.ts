import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { createCleanupRunner } from '@xaa/lifecycle-manager/app';
import { createIdentityDisabledHandler, startIdentityDisabledSubscriber } from '@xaa/lifecycle-manager/src/subscribers/runner';
import { createLifecycleHarness, seedDomain } from '@xaa/lifecycle-manager/src/testing/harness';

const HOUR = 3_600_000;
const logger = createLogger('lifecycle-manager', 'provisioner', () => {});

/**
 * A Pub/Sub subscription, standing in for the real one.
 *
 * The transport is the only thing replaced. Everything downstream of `on('message')`
 * is the production wiring: the same handler, the same cleanup runner the HTTP routes
 * use, and the same Firestore. What the test needs to see is that one delivery settles
 * everything belonging to the person and acks exactly once (DEC-SEC-03).
 */
function subscriptionDouble() {
  const acks: string[] = [];
  let listener: ((message: { data: Buffer; ack(): void; nack(): void }) => void) | undefined;
  return {
    acks,
    subscription: {
      on: (_event: 'message', handler: (message: { data: Buffer; ack(): void; nack(): void }) => void) => {
        listener = handler;
      },
    },
    async publish(payload: unknown): Promise<void> {
      listener!({
        data: Buffer.from(JSON.stringify(payload)),
        ack: () => acks.push('ack'),
        nack: () => acks.push('nack'),
      });
      // The handler is async; one turn of the loop is enough for it to finish here.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

describe('a person whose identity was disabled', () => {
  it('three agents and one transaction are settled by a single event', async () => {
    const shared = createFirestoreDouble();
    const harness = createLifecycleHarness({ shared });
    const ids = [
      'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb',
      'agent-cccccccccccccccccccccccccc',
    ];
    // Three agents at different points in their lives, all of them this person's.
    for (const [index, agentId] of ids.entries()) {
      await seedDomain(harness, {
        agentId, status: ['ACTIVE', 'EXPIRING', 'QUARANTINED'][index],
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
      });
    }
    // And one agent belonging to somebody else, which must not be touched.
    const other = await seedDomain(harness, {
      agentId: 'agent-dddddddddddddddddddddddddd', humanSubject: 'someone-else',
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    await harness.documents.set('provisioning_transactions', 'tx-1', {
      status: 'WAITING_IDP_CONSENT', human_subject: 'testuser', created_at: new Date().toISOString(),
    });

    const feed = subscriptionDouble();
    startIdentityDisabledSubscriber(feed.subscription, createIdentityDisabledHandler({
      documents: harness.documents, logger, cleanup: createCleanupRunner(harness.deps),
    }));

    await feed.publish({ human_subject: 'testuser', disabled_at: '2026-01-01T00:00:00.000Z' });

    // All three are gone — not marked for a later sweep, destroyed now. RULE-28 says
    // remaining lifetime does not enter into it, and none of these had expired.
    for (const agentId of ids) {
      expect(await harness.documents.get('agents', `${agentId}__meta`)).toBeUndefined();
    }
    // The transaction that was still waiting for a human who can no longer answer.
    expect(await harness.documents.get<{ status: string }>('provisioning_transactions', 'tx-1'))
      .toMatchObject({ status: 'ABANDONED' });
    // Somebody else's agent is untouched.
    expect(await harness.documents.get<{ status: string }>('agents', `${other}__meta`))
      .toMatchObject({ status: 'ACTIVE' });

    // One delivery, one ack, and three agents' worth of work behind it.
    expect(feed.acks).toEqual(['ack']);
    expect(harness.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(3);
  });

  it('acks a message it cannot parse rather than letting it come back', async () => {
    const harness = createLifecycleHarness();
    await seedDomain(harness, { expiresAt: new Date(Date.now() + HOUR).toISOString() });

    const feed = subscriptionDouble();
    startIdentityDisabledSubscriber(feed.subscription, createIdentityDisabledHandler({
      documents: harness.documents, logger, cleanup: createCleanupRunner(harness.deps),
    }));

    await feed.publish({ disabled_at: '2026-01-01T00:00:00.000Z' });

    expect(feed.acks).toEqual(['ack']);
    expect(harness.clients.calls).toHaveLength(0);
  });
});
