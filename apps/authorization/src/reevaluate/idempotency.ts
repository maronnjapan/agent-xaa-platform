import type { AuthorizationStore } from '../store/authorization-store.js';

export type DeliveryClaim = 'first_delivery' | 'duplicate';

/**
 * Pub/Sub delivers at least once, and re-evaluation is not free of consequence: each
 * run writes a decision and can ask Lifecycle to destroy and rebuild an agent. The
 * claim is therefore made by the write itself — a `create` that fails because the
 * receipt exists is the duplicate detection, with no window between a read and a
 * write for a second delivery to slip through.
 *
 * The key is the change, not the message: two deliveries of the same change carry
 * different message ids but the same `(human_subject, changed_at)` pair.
 */
export async function claimPermissionChange(
  store: AuthorizationStore,
  change: { human_subject: string; changed_at: string },
  receivedAt: string,
): Promise<DeliveryClaim> {
  const claimed = await store.claimPermissionChange(change.human_subject, change.changed_at, receivedAt);
  return claimed ? 'first_delivery' : 'duplicate';
}
