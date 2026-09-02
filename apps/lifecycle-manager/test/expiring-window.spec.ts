import { describe, expect, it } from 'vitest';
import { createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { sweep } from '../src/sweep.js';
import { cleanupAgent } from '../src/cleanup/index.js';
import { createLifecycleHarness, seedDomain } from '../src/testing/harness.js';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };
const MINUTE = 60_000;

/**
 * Every status an agent is given, in the order it was given, seen at the write itself.
 *
 * Polling the record between ticks would miss the states it passes through inside one
 * tick — and passing through EXPIRING on the way to EXPIRED is exactly the property
 * under test, since the state machine has no ACTIVE-to-EXPIRED edge to take instead.
 */
function recordingStore(documents: DocumentStore, seen: string[]): DocumentStore {
  return {
    ...documents,
    async transaction(body) {
      return documents.transaction(async (transaction) => body({
        ...transaction,
        update(collection, id, patch) {
          const status = patch.status;
          if (collection === 'agents' && typeof status === 'string' && seen.at(-1) !== status) seen.push(status);
          transaction.update(collection, id, patch);
        },
      }));
    },
  };
}

describe('the expiring window', () => {
  /**
   * Demo D-3's agent, on the ordinary machinery.
   *
   * Nothing here knows the agent is short-lived: the same sweep, the same sixty-second
   * warning window and the same `expires_at` comparison that every agent gets. A demo
   * that needed a special path would prove nothing about the platform it demonstrates.
   */
  it('a 3 minute agent passes ACTIVE, EXPIRING, EXPIRED and DESTROYED in order', async () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    const shared = createFirestoreDouble();
    const seen: string[] = [];
    let clock = start;

    const harness = createLifecycleHarness({ shared, now: () => clock });
    const documents = recordingStore(harness.documents, seen);
    const agentId = await seedDomain(harness, { expiresAt: new Date(start + 3 * MINUTE).toISOString() });
    expect((await harness.documents.get<{ status: string }>('agents', `${agentId}__meta`))!.status).toBe('ACTIVE');
    seen.push('ACTIVE');

    const tick = (): Promise<unknown> => sweep({
      documents, expiringWindowSeconds: 60, now: () => clock,
      cleanup: async (id, reason) => {
        const outcome = await cleanupAgent(id, reason, {
          documents, clients: harness.clients, logger, logContext, now: () => clock,
        });
        // DESTROYED is never written to the record, because step11 removed the record
        // first — deliberately, since a status field on a document nobody keeps would
        // be a state nothing could read. Cleanup's own answer is where it is observable.
        if (seen.at(-1) !== outcome.status) seen.push(outcome.status);
        return outcome;
      },
    });

    // t+1m: two minutes of life left, which is outside the sixty-second window.
    clock = start + MINUTE;
    await tick();
    expect(seen).toEqual(['ACTIVE']);

    // t+2m30s: inside the window, so the agent is warned and nothing else happens.
    clock = start + 2.5 * MINUTE;
    await tick();
    expect(seen).toEqual(['ACTIVE', 'EXPIRING']);
    expect(harness.clients.calls).toHaveLength(0);

    // t+4m: past the deadline. One tick walks it to EXPIRED and cleans it up.
    clock = start + 4 * MINUTE;
    await tick();

    expect(seen.filter((status) => status !== 'REVOKED'))
      .toEqual(['ACTIVE', 'EXPIRING', 'EXPIRED', 'DESTROYED']);
    // REVOKED is passed through on the way, because cleanup claims the agent before it
    // starts and only reports DESTROYED once every step is done.
    expect(seen).toEqual(['ACTIVE', 'EXPIRING', 'EXPIRED', 'REVOKED', 'DESTROYED']);
    expect(await harness.documents.get('agents', `${agentId}__meta`)).toBeUndefined();
  });

  it('leaves an agent alone while its expiry is further off than the window', async () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    const harness = createLifecycleHarness({ now: () => start });
    const agentId = await seedDomain(harness, { expiresAt: new Date(start + 10 * MINUTE).toISOString() });
    const counters = await sweep({
      documents: harness.documents, expiringWindowSeconds: 60, now: () => start,
      cleanup: (id, reason) => cleanupAgent(id, reason, {
        documents: harness.documents, clients: harness.clients, logger, logContext, now: () => start,
      }),
    });
    expect(counters).toMatchObject({ expiring: 0, expired: 0 });
    expect((await harness.documents.get<{ status: string }>('agents', `${agentId}__meta`))!.status).toBe('ACTIVE');
  });
});
