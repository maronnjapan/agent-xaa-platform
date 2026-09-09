/** The subscription surface both pull loops in this platform read (and no more of it). */
export interface PullSubscription {
  on(event: 'message', listener: (message: { data: Buffer; ack(): void; nack(): void }) => void): void;
}

export interface PushTarget {
  /** The absolute endpoint Pub/Sub posts to, as `pubsub-push.tf` spells it. */
  endpoint: string;
  /** The audience of the OIDC token attached to the delivery. */
  audience: string;
  /** Mints that token; the local service identity, standing in for Pub/Sub's. */
  token(audience: string): Promise<string>;
}

export interface LocalPubSub {
  /** The `@google-cloud/pubsub` shape `publishActivityEvent` writes through. */
  topic(name: string): { publishMessage(message: { json: unknown }): Promise<string> };
  publish(topic: string, payload: unknown): Promise<void>;
  /** A pull subscription, as Security Detection and the Lifecycle Manager take one. */
  pullSubscription(topic: string): PullSubscription;
  /** A push subscription, delivered over real HTTP with a real OIDC token. */
  pushSubscription(topic: string, target: PushTarget): void;
  /** Waits for deliveries already in flight; the tests use it, the runner does not. */
  drain(): Promise<void>;
}

type Delivery = (payload: unknown) => Promise<void>;

/**
 * Pub/Sub, in this process.
 *
 * Every asynchronous edge in `infra/envs/demo` is one of two kinds, and both are here:
 * a push subscription that POSTs to a service with an OIDC token, and a pull
 * subscription a service reads from. The push kind really does go out over HTTP to the
 * service's own port with a token the receiver verifies, because the endpoint it
 * reaches — `/internal/activity/push` — is only defensible if the caller check on it
 * runs; a local shortcut straight into the handler would leave the platform's one
 * unauthenticated-looking route untested on the machine where people develop it.
 *
 * Delivery is fire-and-forget, as Pub/Sub's is: a publisher never waits for its
 * subscribers, and a subscriber that throws loses the message rather than blocking the
 * publisher. `drain` exists so a test can wait for what a person would simply see
 * arrive a moment later.
 */
export function createLocalPubSub(options: { onError?: (topic: string, error: unknown) => void } = {}): LocalPubSub {
  const subscribers = new Map<string, Delivery[]>();
  const inFlight = new Set<Promise<void>>();

  const deliver = (topic: string, payload: unknown): void => {
    for (const subscriber of subscribers.get(topic) ?? []) {
      const promise = subscriber(payload)
        .catch((error: unknown) => { options.onError?.(topic, error); })
        .finally(() => { inFlight.delete(promise); });
      inFlight.add(promise);
    }
  };

  const add = (topic: string, delivery: Delivery): void => {
    subscribers.set(topic, [...(subscribers.get(topic) ?? []), delivery]);
  };

  return {
    topic: (name) => ({
      async publishMessage(message) {
        deliver(name, message.json);
        return `local-${name}-${Date.now()}`;
      },
    }),
    async publish(topic, payload) { deliver(topic, payload); },
    pullSubscription(topic) {
      return {
        on(_event, listener) {
          add(topic, async (payload) => {
            await new Promise<void>((resolve) => {
              listener({
                data: Buffer.from(JSON.stringify(payload), 'utf8'),
                ack: () => resolve(),
                // A nack is a redelivery on GCP. Here it is a dropped message and a
                // logged error: retrying inside one process would spin on a payload
                // that is going to fail the same way every time.
                nack: () => resolve(),
              });
            });
          });
        },
      };
    },
    pushSubscription(topic, target) {
      add(topic, async (payload) => {
        const response = await fetch(target.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await target.token(target.audience)}`,
          },
          body: JSON.stringify({
            message: {
              data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
              messageId: `local-${Date.now()}`,
              publishTime: new Date().toISOString(),
            },
            subscription: `projects/local/subscriptions/${topic}`,
          }),
        });
        if (!response.ok) throw new Error(`push delivery to ${target.endpoint} answered ${response.status}`);
      });
    },
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
