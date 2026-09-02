import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
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

  /**
   * The config listing a module is not the same as the rule firing on it: a later
   * block that also sets no-restricted-imports replaces these options rather than
   * adding to them, and the restriction went silently inert that way once already.
   */
  it('lint fails on forbidden import fixture', async () => {
    const fixture = await readFile(new URL('fixtures/forbidden-import.ts.txt', import.meta.url).pathname, 'utf8');
    const target = 'apps/agent-op/test/fixtures/forbidden-import.generated.ts';
    await writeFile(`${repoRoot}${target}`, fixture, 'utf8');
    try {
      // ESLint's own API rather than a child process: this runs inside the parallel
      // unit suite, where a second Node start-up is pure contention.
      const { ESLint } = await import('eslint');
      const results = await new ESLint({ cwd: repoRoot }).lintFiles([target]);
      const rules = results.flatMap((file) => file.messages.map((message) => message.ruleId));
      expect(rules.filter((ruleId) => ruleId === 'no-restricted-imports')).toHaveLength(2);
      // `eslint .` would exit non-zero on exactly these findings.
      expect(results.reduce((total, file) => total + file.errorCount, 0)).toBeGreaterThan(0);
    } finally {
      await rm(`${repoRoot}${target}`, { force: true });
    }
  }, 60_000);

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
