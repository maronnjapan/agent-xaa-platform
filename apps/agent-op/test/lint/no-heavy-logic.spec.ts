import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * REQ-09-038: Agent OP performs protocol validation synchronously and emits structured
 * logs. Rule evaluation, correlation, scoring and Security AI belong to Security
 * Detection. ESLint enforces this with no-restricted-imports; this spec pins the same
 * boundary so a rename of the security package cannot silently reopen it.
 */
const FORBIDDEN = [
  '@platform/security/rules',
  '@platform/security/correlation',
  '@platform/security/scoring',
  '@platform/security/ai',
];

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string): Promise<void> => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };
  await walk(directory);
  return found;
}

describe('agent-op keeps detection logic out of the issuance path', () => {
  it('imports no security rule, correlation, scoring or AI module', async () => {
    const files = await sources(new URL('../../src', import.meta.url).pathname);
    const offenders = [] as string[];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const module of FORBIDDEN) if (source.includes(module)) offenders.push(`${file}: ${module}`);
    }
    expect(offenders).toEqual([]);
  });

  it('lists the same modules the eslint config restricts', async () => {
    const config = await readFile(new URL('../../../../eslint.config.js', import.meta.url).pathname, 'utf8');
    for (const module of FORBIDDEN) expect(config).toContain(module);
  });
});
