import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FORBIDDEN_ENV_KEYS, RUNTIME_ENV_KEYS, RUNTIME_EXIT_CODES } from '@xaa/contracts';
import { ForbiddenEnvKey, MissingEnvKey, loadEnv } from '../src/env.js';
import { runtimeEnv } from './helpers.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;

async function sourceFiles(): Promise<Array<{ path: string; text: string }>> {
  const root = new URL('../src', import.meta.url).pathname;
  const found: Array<{ path: string; text: string }> = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.name.endsWith('.ts')) found.push({ path: full, text: await readFile(full, 'utf8') });
    }
  };
  await walk(root);
  return found;
}

async function envFor(): Promise<Record<string, string>> {
  const env = await runtimeEnv();
  return Object.fromEntries(RUNTIME_ENV_KEYS.map((key) => [key, env[key]]));
}

describe('the startup contract', () => {
  it('rejects forbidden env keys', async () => {
    for (const key of FORBIDDEN_ENV_KEYS) {
      const source = { ...(await envFor()), [key]: 'anything' };
      expect(() => loadEnv(source)).toThrow(ForbiddenEnvKey);
    }
    expect(RUNTIME_EXIT_CODES.invalidStartup).toBe(78);
  });

  it('rejects a forbidden key before it needs any other value', () => {
    // Nothing else is set: the forbidden check must still be what fails.
    expect(() => loadEnv({ HUMAN_ACCESS_TOKEN: 'x' })).toThrow(ForbiddenEnvKey);
  });

  it('requires every override key', async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const source = { ...(await envFor()) };
      delete source[key];
      expect(() => loadEnv(source)).toThrow(MissingEnvKey);
    }
  });

  it('takes execution id and task index from what Cloud Run injects', async () => {
    const base = await envFor();
    expect(loadEnv({ ...base, CLOUD_RUN_EXECUTION: 'exec-9', CLOUD_RUN_TASK_INDEX: '3' }))
      .toMatchObject({ executionId: 'exec-9', taskIndex: 3 });
    expect(loadEnv(base).executionId).toMatch(/^local-/);
  });

  it('exits 78 for a forbidden key when started as a process', async () => {
    const base = await envFor();
    const script = 'const { loadEnv, ForbiddenEnvKey } = await import(process.argv[1]);'
      + ' try { loadEnv(); process.exit(0); } catch (error) { process.exit(error instanceof ForbiddenEnvKey ? 78 : 1); }';
    let code = 0;
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', script, join(repoRoot, 'apps/agent-runtime/dist/env.js')], {
        env: { ...base, HUMAN_ACCESS_TOKEN: 'leaked', PATH: process.env.PATH ?? '' },
        stdio: 'ignore',
      });
    } catch (error) { code = (error as { status: number }).status; }
    expect(code).toBe(78);
  });
});

describe('the runtime listens on nothing', () => {
  it('has no server, no port and no route', async () => {
    for (const file of await sourceFiles()) {
      // Comments may describe the absence; code may not create one.
      const code = file.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toMatch(/\bserve\(|\.listen\(|createServer/);
      expect(code).not.toMatch(/process\.env\.PORT/);
      expect(code).not.toMatch(/from 'hono'|@hono\/node-server/);
    }
  });

  it('declares no http server dependency', async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps/agent-runtime/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).not.toContain('hono');
    expect(Object.keys(manifest.dependencies)).not.toContain('@hono/node-server');
  });

  it('is not deployed as a Cloud Run Service', () => {
    expect(() => execFileSync('bash', ['infra/tests/no-runtime-service.sh'], { cwd: repoRoot })).not.toThrow();
  });

  it('holds no signing or secret-reading role', () => {
    expect(() => execFileSync('bash', ['infra/tests/runtime-sa-roles.sh'], { cwd: repoRoot })).not.toThrow();
  });
});
