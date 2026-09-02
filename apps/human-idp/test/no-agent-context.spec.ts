import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createTestApp } from './helpers.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;

describe('Human IdP holds no agent context', () => {
  it('POST /register returns 404', async () => {
    const app = await createTestApp();
    const response = await app.fetch('/register', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });

  it('GET /register returns 404', async () => {
    const app = await createTestApp();
    expect((await app.fetch('/register')).status).toBe(404);
  });

  it('passes the purity check', () => {
    expect(() => execFileSync('bash', ['scripts/check-human-idp-purity.sh'], { cwd: repoRoot })).not.toThrow();
  });

  it('fails the purity check when agent context is planted in src', () => {
    const planted = `${repoRoot}apps/human-idp/src/tmp.ts`;
    writeFileSync(planted, 'const agentId = 1\n');
    try {
      expect(() => execFileSync('bash', ['scripts/check-human-idp-purity.sh'], { cwd: repoRoot, stdio: 'pipe' }))
        .toThrow(/Command failed/);
    } finally {
      rmSync(planted, { force: true });
    }
  });
});
