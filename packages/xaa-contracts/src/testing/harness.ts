import { generateEs256KeyPair, InMemoryJtiStore, createLocalEs256Signer } from '@xaa/crypto';
import type { Hono } from 'hono';
import type { CreateApp } from '../app-contract.js';
import { createHttpClient, resetTransportForTesting, setTransport } from '../http-client.js';
import type { PlatformEndpoints } from '../schema/platform-endpoints.schema.js';
import type { ServiceId } from '../service-ids.js';

const dummyEndpoints = new Proxy({}, { get: (_, key) => `https://${String(key)}.test` }) as PlatformEndpoints;

export interface Harness {
  fetch(serviceId: ServiceId, path: string, init?: RequestInit): Promise<Response>;
  advanceTime(seconds: number): void;
  dispose(): void;
}

export async function createHarness(factories: Partial<Record<ServiceId, CreateApp>>): Promise<Harness> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network access blocked by integration harness'); };
  let currentTime = Date.now();
  const now = () => currentTime;
  const jtiStore = new InMemoryJtiStore(now);
  const pair = await generateEs256KeyPair();
  const signer = createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'test-1' });
  const apps = new Map<ServiceId, Hono>();
  const transport = async (serviceId: ServiceId, request: Request) => {
    const app = apps.get(serviceId);
    if (!app) throw new Error(`unregistered service: ${serviceId}`);
    return app.fetch(request);
  };
  resetTransportForTesting();
  setTransport(transport);
  const httpClient = createHttpClient({ endpoints: dummyEndpoints, transport });
  for (const [id, factory] of Object.entries(factories) as [ServiceId, CreateApp][]) {
    apps.set(id, factory({ httpClient, signer, jtiStore, now, store: new Map(), logger: { info() {}, error() {} } }));
  }
  return {
    async fetch(serviceId, path, init) {
      const app = apps.get(serviceId);
      if (!app) throw new Error(`unregistered service: ${serviceId}`);
      return await app.fetch(new Request(new URL(path, `https://${serviceId}.test`), init));
    },
    advanceTime(seconds) { currentTime += seconds * 1000; },
    dispose() { globalThis.fetch = originalFetch; resetTransportForTesting(); },
  };
}
