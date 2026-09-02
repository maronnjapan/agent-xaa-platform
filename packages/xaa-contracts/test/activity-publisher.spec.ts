import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_TOPIC, drainActivityQueueForTesting, publishActivityEvent, resetActivityPublisherForTesting,
  validateActivityEvent, type ActivityEvent,
} from '../src/index.js';

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return validateActivityEvent({
    event_id: 'ev-1', trace_id: 'tr-1', human_subject: 'user-123', agent_id: null, task_id: 'provisioning',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', phase: 'login', outcome: 'info',
    title: 'ログインしました', message: 'ログインしました。', related_finding_id: null, is_simulated: false,
    ...overrides,
  });
}

/**
 * REQ-11-002 / REQ-11-005. One topic, and a title and a message that were written by
 * the app that knew why the thing happened.
 */
describe('publishing an Activity Event', () => {
  beforeEach(() => resetActivityPublisherForTesting());

  it('rejects empty title', async () => {
    await expect(publishActivityEvent(event({ title: ' ' }))).rejects.toThrow(/title/);
    expect(drainActivityQueueForTesting()).toEqual([]);
  });

  it('rejects empty message', async () => {
    await expect(publishActivityEvent(event({ message: '  ' }))).rejects.toThrow(/message/);
    expect(drainActivityQueueForTesting()).toEqual([]);
  });

  it('names one topic and sends the event to it', async () => {
    const published: Array<{ json: unknown }> = [];
    const topics: string[] = [];
    resetActivityPublisherForTesting({
      topic(name) {
        topics.push(name);
        return { async publishMessage(message) { published.push(message); return 'id'; } };
      },
    });
    const previous = process.env.PUBSUB_MODE;
    process.env.PUBSUB_MODE = 'gcp';
    try {
      await publishActivityEvent(event());
    } finally {
      if (previous === undefined) delete process.env.PUBSUB_MODE; else process.env.PUBSUB_MODE = previous;
    }
    expect(topics).toEqual([ACTIVITY_TOPIC]);
    expect(published).toHaveLength(1);
  });

  /**
   * RULE-55. The timeline is a separate channel: an Activity Event that also reached
   * Cloud Logging would be picked up by the log sink, normalised, and end up in the
   * security audit stream — the exact mixing the two channels exist to prevent.
   */
  it('writes the message to no log', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await publishActivityEvent(event({ message: 'この文字列はログに出てはならない' }));
    } finally {
      stdout.mockRestore();
      log.mockRestore();
    }
    for (const call of [...stdout.mock.calls, ...log.mock.calls]) {
      expect(String(call[0])).not.toContain('この文字列はログに出てはならない');
    }
    expect(drainActivityQueueForTesting()).toHaveLength(1);
  });
});
