import { validateActivityEvent, type ActivityEvent } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

export const ACTIVITY_RETENTION_DAYS = 7;

export class InvalidActivityMessage extends Error {}

/**
 * The logical path of docs 11 §3.2, `users/{human_subject}/activity/{event_id}`.
 *
 * Firestore paths alternate collection and document, and a query needs a collection of
 * its own, so the rows live flat in `user_activity` keyed by `event_id` with the
 * subject as a field. This function is where the logical path is stated and checked:
 * a subject containing a slash would silently address a different person's segment,
 * so it is refused rather than escaped.
 */
export const ACTIVITY_COLLECTION = 'user_activity';

export function buildActivityPath(humanSubject: string, eventId: string): string {
  for (const value of [humanSubject, eventId]) {
    if (value === '' || value.includes('/') || value.includes('..')) throw new Error('invalid activity path segment');
  }
  return `users/${humanSubject}/activity/${eventId}`;
}

export function decodePushMessage(body: unknown): ActivityEvent {
  const message = (body as { message?: { data?: string } })?.message;
  if (!message?.data) throw new InvalidActivityMessage('push body has no message.data');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  } catch {
    throw new InvalidActivityMessage('message.data is not JSON');
  }
  return validateActivityEvent(parsed);
}

/**
 * Writes one event, once, however many times Pub/Sub delivers it.
 *
 * At-least-once delivery means a duplicate is normal, not exceptional. Using the
 * `event_id` as the document id and `create` rather than `set` turns a redelivery into
 * an `ALREADY_EXISTS` that the caller can answer 200 to — the row keeps its original
 * content, which matters because the second copy may arrive after something else has
 * read the first.
 *
 * `set` with merge would let a redelivery quietly rewrite an event that is already on
 * a person's screen.
 */
export async function storeActivityEvent(input: {
  documents: DocumentStore;
  event: ActivityEvent;
}): Promise<'created' | 'duplicate'> {
  const expireAt = new Date(Date.parse(input.event.occurred_at) + ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
  buildActivityPath(input.event.human_subject, input.event.event_id);
  try {
    await input.documents.create(ACTIVITY_COLLECTION, input.event.event_id, { ...input.event, expire_at: expireAt });
    return 'created';
  } catch (error) {
    if ((error as { code?: number }).code === 6) return 'duplicate';
    throw error;
  }
}
