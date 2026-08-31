import { validateActivityEvent, type ActivityEvent } from './activity-event.js';

/**
 * DEC-DEMO-01 / REQ-11-005: one topic, one name, everywhere.
 *
 * Activity Events never go to Cloud Logging and never go to BigQuery. The security
 * audit stream is a different channel with a different retention and a different
 * reader (RULE-55); mixing them would put a person's timeline into the detection
 * pipeline and the detection findings onto their screen.
 */
export const ACTIVITY_TOPIC = 'agent-activity-stream';

interface PubSubLike {
  topic(name: string): { publishMessage(message: { json: unknown }): Promise<unknown> };
}

const memoryQueue: ActivityEvent[] = [];
let gcpClient: PubSubLike | undefined;

export function drainActivityQueueForTesting(): ActivityEvent[] {
  return memoryQueue.splice(0, memoryQueue.length);
}

export function resetActivityPublisherForTesting(): void {
  memoryQueue.length = 0;
  gcpClient = undefined;
}

export async function publishActivityEvent(event: ActivityEvent): Promise<void> {
  // Empty strings pass a `type: string` check but produce a blank row on screen,
  // which is worse than a loud failure at the publisher.
  if (event.title.trim() === '') throw new Error('activity event title must not be empty');
  if (event.message.trim() === '') throw new Error('activity event message must not be empty');
  const validated = validateActivityEvent(event);
  if (process.env.PUBSUB_MODE !== 'gcp') {
    memoryQueue.push(validated);
    return;
  }
  if (!gcpClient) {
    const { PubSub } = await import('@google-cloud/pubsub');
    gcpClient = new PubSub() as unknown as PubSubLike;
  }
  await gcpClient.topic(ACTIVITY_TOPIC).publishMessage({ json: validated });
}
