export type MessageHandler = (payload: unknown) => Promise<void>;

export interface PullSubscription {
  on(event: 'message', listener: (message: { data: Buffer; ack(): void; nack(): void }) => void): void;
}

/**
 * Pull, not push.
 *
 * This service runs with INTERNAL_ONLY ingress, so a Pub/Sub push subscription cannot
 * reach it (DEC-SEC-03). Pulling also means the acknowledgement is ours to place: a
 * message is acked only after the handler has finished, and nacked when it throws, so a
 * detection run that fails is retried rather than lost.
 */
export function startPullLoop(subscription: PullSubscription, handler: MessageHandler): void {
  subscription.on('message', (message) => {
    void (async () => {
      try {
        await handler(JSON.parse(message.data.toString('utf8')));
        message.ack();
      } catch {
        // Redelivery is the retry: nothing here decides to drop a message it could not
        // process, because that is evidence going missing.
        message.nack();
      }
    })();
  });
}

/** In-process delivery for the tests, wired to the same handler (DEC-APP-09). */
export function createInProcessBus(): {
  publish(payload: unknown): Promise<void>;
  subscribe(handler: MessageHandler): void;
} {
  let installed: MessageHandler | undefined;
  return {
    subscribe(handler) { installed = handler; },
    async publish(payload) { await installed?.(payload); },
  };
}
