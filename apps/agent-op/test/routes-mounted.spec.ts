import { describe, expect, it } from 'vitest';
import { createFixture } from './helpers.js';

const OIDC_PATHS = ['/authorize', '/userinfo', '/logout', '/introspect', '/revoke', '/.well-known/openid-configuration'];

describe('two modes, disjoint route surfaces', () => {
  it('MODE=callback rejects /xaa/token with 404', async () => {
    const fixture = await createFixture({ config: { mode: 'callback' } });
    expect((await fixture.fetch('/xaa/token', { method: 'POST' })).status).toBe(404);
    expect((await fixture.fetch('/xaa/subject-token', { method: 'POST' })).status).toBe(404);
  });

  it('MODE=token rejects /xaa/callback with 404', async () => {
    const fixture = await createFixture();
    expect((await fixture.fetch('/xaa/callback?state=x')).status).toBe(404);
  });

  it('both modes reject /authorize and /.well-known/openid-configuration with 404', async () => {
    for (const mode of ['token', 'callback'] as const) {
      const fixture = await createFixture({ config: { mode } });
      for (const path of OIDC_PATHS) {
        expect((await fixture.fetch(path)).status, `${mode} ${path}`).toBe(404);
      }
    }
  });

  it('serves /healthz in both modes', async () => {
    for (const mode of ['token', 'callback'] as const) {
      const fixture = await createFixture({ config: { mode } });
      expect((await fixture.fetch('/healthz')).status).toBe(200);
    }
  });

  it('rejects a MODE outside token and callback at startup', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ MODE: 'gateway' })).toThrow(/invalid MODE/);
  });

  it('reads process.env only in config.ts', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = new URL('../src', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        // config.ts owns the contract; runtime.ts is the composition root that hands
        // it the environment and reads Cloud Run's own K_REVISION.
        if (['config.ts', 'runtime.ts'].includes(entry.name)) continue;
        if ((await readFile(full, 'utf8')).includes('process.env')) offenders.push(full);
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });
});
