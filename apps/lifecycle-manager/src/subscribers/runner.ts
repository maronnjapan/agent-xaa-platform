import type { DocumentStore } from '@xaa/gcp';
import type { Logger } from '@xaa/logging';
import type { CleanupOutcome } from '../cleanup/result.js';
import { handleIdentityDisabled } from './identity-disabled.js';

export type IdentityDisabledHandler = (message: unknown) => Promise<void>;

/** The shape `@google-cloud/pubsub`'s subscription presents, and nothing more of it. */
export interface PullSubscription {
  on(event: 'message', listener: (message: { data: Buffer; ack(): void; nack(): void }) => void): void;
}

/**
 * The identity feed, pulled rather than pushed (DEC-SEC-03).
 *
 * This runs beside `createApp()` rather than inside it: a revocation triggered by a
 * disabled identity is not a request anybody makes, and giving it an HTTP route would
 * mean a second way to destroy an agent. Every message is acked — the handler already
 * treats an invalid message as final and leaves a failed agent to the sweep, so
 * redelivering would re-run cleanup for the agents it did settle.
 */
export function startIdentityDisabledSubscriber(
  subscription: PullSubscription,
  handler: IdentityDisabledHandler,
): void {
  subscription.on('message', (message) => {
    void (async () => {
      try {
        await handler(JSON.parse(message.data.toString('utf8')));
      } catch {
        // Nothing here decides to retry: the handler owns that decision per agent.
      }
      message.ack();
    })();
  });
}

/** Binds the handler to the app's own dependencies, so both see one Firestore. */
export function createIdentityDisabledHandler(deps: {
  documents: DocumentStore;
  logger: Logger;
  cleanup(agentId: string, reason: 'IDENTITY_DISABLED'): Promise<CleanupOutcome>;
  now?: () => number;
}): IdentityDisabledHandler {
  return async (message) => {
    await handleIdentityDisabled({
      message,
      documents: deps.documents,
      logger: deps.logger,
      logContext: { request_id: 'identity-disabled', trace_id: 'identity-disabled', agent_id: null, human_subject: null },
      cleanup: deps.cleanup,
      ...(deps.now ? { now: deps.now } : {}),
    });
  };
}
