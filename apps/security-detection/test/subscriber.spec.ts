import { describe, expect, it } from 'vitest';
import { createInProcessBus, startPullLoop } from '../src/ingest/subscriber.js';

type Listener = (message: { data: Buffer; ack(): void; nack(): void }) => void;

function pullLoop(handler: (payload: unknown) => Promise<void>) {
  const settled: string[] = [];
  let listener: Listener | undefined;
  startPullLoop({ on: (_event, installed) => { listener = installed; } }, handler);
  return {
    settled,
    deliver(body: unknown) {
      listener!({
        data: Buffer.from(JSON.stringify(body)),
        ack: () => settled.push('ack'),
        nack: () => settled.push('nack'),
      });
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/**
 * T-SEC-08. The one way in.
 *
 * The acknowledgement is placed by this service and not by the transport, which is the
 * whole reason pull was chosen over push: a detection run that threw must come back.
 * Acking first and processing after would turn every transient failure into evidence
 * that silently never existed.
 */
describe('the security-logs pull loop', () => {
  it('acks after the handler has finished', async () => {
    const order: string[] = [];
    const loop = pullLoop(async () => { order.push('handled'); });
    await loop.deliver({ ok: true });
    expect(order).toEqual(['handled']);
    expect(loop.settled).toEqual(['ack']);
  });

  it('nacks on handler failure', async () => {
    const loop = pullLoop(async () => { throw new Error('handler failed'); });
    await loop.deliver({ ok: false });
    expect(loop.settled).toEqual(['nack']);
  });

  it('nacks a message it cannot parse rather than dropping it', async () => {
    let called = 0;
    const settled: string[] = [];
    let listener: Listener | undefined;
    startPullLoop({ on: (_event, installed) => { listener = installed; } }, async () => { called += 1; });
    listener!({
      data: Buffer.from('not json'),
      ack: () => settled.push('ack'), nack: () => settled.push('nack'),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(called).toBe(0);
    expect(settled).toEqual(['nack']);
  });

  it('delivers in process for the tests', async () => {
    const bus = createInProcessBus();
    const seen: unknown[] = [];
    bus.subscribe(async (payload) => { seen.push(payload); });
    await bus.publish({ a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
  });
});
