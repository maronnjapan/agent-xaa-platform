import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createFixture, exchange } from './helpers.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const run = (script: string) => execFileSync('bash', [script], { cwd: repoRoot });

describe('Agent OP responsibility boundary', () => {
  it('passes the boundary script', () => {
    expect(() => run('scripts/check-agent-op-boundary.sh')).not.toThrow();
  });

  it('keeps asymmetricSign to one module', () => {
    expect(() => run('scripts/check-single-asymmetric-sign.sh')).not.toThrow();
  });

  it('never calls a general purpose verifyJwt from a route or middleware', () => {
    expect(() => run('scripts/check-no-raw-verify-jwt.sh')).not.toThrow();
  });

  it('lists the forbidden imports in the eslint config', async () => {
    const config = await readFile(`${repoRoot}eslint.config.js`, 'utf8');
    for (const module of ['@platform/security/rules', '@platform/security/correlation', '@platform/security/scoring', '@platform/security/ai']) {
      expect(config).toContain(module);
    }
  });

  it('completes the issuance flow with global fetch disabled', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('Agent OP must not reach the network during issuance'); }) as unknown as typeof fetch;
    try {
      const fixture = await createFixture();
      expect((await exchange(fixture)).status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
  });
});
