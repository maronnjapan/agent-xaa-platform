import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHarness } from '../src/testing/harness.js';
import type { CreateApp } from '../src/app-contract.js';

const echoApp: CreateApp = (deps) => {
  const app = new Hono();
  app.get('/echo', (context) => context.json({ ok: true, hasSigner: Boolean(deps?.signer) }));
  return app;
};

const callerApp: CreateApp = (deps) => {
  const app = new Hono();
  app.get('/call', async (context) => {
    const response = await deps!.httpClient.request('resource-docs-api', '/echo');
    return context.json(await response.json() as Record<string, unknown>);
  });
  app.onError((error, context) => context.json({ error: error.message }, 500));
  return app;
};

describe('integration harness', () => {
  it('routes service id to app.fetch', async () => {
    const harness = await createHarness({ 'resource-docs-api': echoApp, provisioner: callerApp });
    try {
      const response = await harness.fetch('provisioner', '/call');
      expect(await response.json()).toEqual({ ok: true, hasSigner: true });
    } finally { harness.dispose(); }
  });

  it('unregistered service id throws', async () => {
    const harness = await createHarness({ provisioner: callerApp });
    try {
      const response = await harness.fetch('provisioner', '/call');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'unregistered service: resource-docs-api' });
      await expect(harness.fetch('lifecycle', '/x')).rejects.toThrow('unregistered service: lifecycle');
    } finally { harness.dispose(); }
  });

  it('global fetch is blocked inside harness and restored on dispose', async () => {
    const original = globalThis.fetch;
    const harness = await createHarness({});
    await expect(globalThis.fetch('https://example.com')).rejects.toThrow('network access blocked by integration harness');
    harness.dispose();
    expect(globalThis.fetch).toBe(original);
  });

  it('advanceTime moves the injected clock forward', async () => {
    const seen: number[] = [];
    const clockApp: CreateApp = (deps) => {
      const app = new Hono();
      app.get('/now', (context) => { seen.push(deps!.now()); return context.text('ok'); });
      return app;
    };
    const harness = await createHarness({ lifecycle: clockApp });
    try {
      await harness.fetch('lifecycle', '/now');
      harness.advanceTime(120);
      await harness.fetch('lifecycle', '/now');
      expect(seen[1]! - seen[0]!).toBe(120_000);
    } finally { harness.dispose(); }
  });
});
