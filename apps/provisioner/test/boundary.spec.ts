import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRuntimeName, dedicatedNames, ForbiddenRuntimeName, RUNTIME_NAME_PREFIXES, shortId } from '../src/dedicated-names.js';
import { DEDICATED_AGENT_SA_ROLES, DEDICATED_OP_SA_ROLES } from '@xaa/contracts';

const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
const repoRoot = new URL('../../../', import.meta.url).pathname;

async function sources(): Promise<Array<{ path: string; text: string }>> {
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

describe('the runtime name space', () => {
  it('refuses a Terraform-managed name', () => {
    for (const name of ['human-idp', 'shared-agent-op', 'automation-app', 'authorization', 'lifecycle']) {
      expect(() => assertRuntimeName(name)).toThrow(ForbiddenRuntimeName);
    }
  });

  it('accepts each of the six runtime prefixes', () => {
    const names = dedicatedNames(AGENT_ID);
    for (const name of [names.opService, names.opServiceAccount, names.agentServiceAccount, names.signingKey, names.connectionKey, names.runtimeJob]) {
      expect(() => assertRuntimeName(name)).not.toThrow();
    }
    expect(RUNTIME_NAME_PREFIXES).toHaveLength(6);
  });

  it('accepts a fully qualified name whose leaf carries a runtime prefix', () => {
    expect(() => assertRuntimeName('projects/p/locations/l/services/dedicated-op-abcdefghijkl')).not.toThrow();
    expect(() => assertRuntimeName('projects/p/locations/l/services/human-idp')).toThrow(ForbiddenRuntimeName);
  });

  it('keeps every service account id inside the GCP length limit', () => {
    const names = dedicatedNames(AGENT_ID);
    for (const accountId of [names.opServiceAccount, names.agentServiceAccount]) {
      expect(accountId.length).toBeGreaterThanOrEqual(6);
      expect(accountId.length).toBeLessThanOrEqual(30);
    }
    expect(shortId(AGENT_ID)).toHaveLength(12);
  });
});

describe('the provisioner keeps inside its boundary', () => {
  it('names no IAM role of its own', async () => {
    const dedicated = (await sources()).find((file) => file.path.endsWith('dedicated.ts'))!;
    const roleLines = dedicated.text.split('\n').filter((line) => line.includes('roles/'));
    expect(roleLines).toEqual([]);
    expect(dedicated.text).toContain('DEDICATED_OP_SA_ROLES');
    expect(DEDICATED_OP_SA_ROLES.length).toBeGreaterThan(0);
    expect(DEDICATED_AGENT_SA_ROLES.length).toBeGreaterThan(0);
  });

  it('creates GCP resources only from the dedicated module', async () => {
    const offenders = (await sources())
      // dedicated.ts is the one caller; runtime.ts builds the real client; the test
      // harness implements the same interface with recorders and calls nothing.
      .filter((file) => !file.path.endsWith('dedicated.ts') && !file.path.endsWith('runtime.ts')
        && !file.path.includes('/testing/'))
      .filter((file) => /\b(createServiceAccount|createCryptoKey|createService|createJob)\s*\(/.test(file.text));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('reaches the dedicated module only from the full_isolation branch', async () => {
    const route = (await sources()).find((file) => file.path.endsWith('routes/provisioning.ts'))!;
    const lines = route.text.split('\n');
    const guard = lines.findIndex((line) => line.includes("isolationLevel === 'full_isolation'") && line.includes('if ('));
    const call = lines.findIndex((line) => line.includes('deps.createDedicated('));
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
  });

  it('uses none of the discarded capacity error names', async () => {
    const text = (await sources()).map((file) => file.text).join('\n');
    for (const discarded of ['dedicated_op_slot_exhausted', 'no_isolation_slot_available', 'slot_unavailable', 'isolation_slots', 'dedicated_op_slots']) {
      expect(text).not.toContain(discarded);
    }
  });

  it('passes the runtime mutation scope check', () => {
    expect(() => execFileSync('bash', ['infra/tests/runtime-mutation-scope.sh'], { cwd: repoRoot })).not.toThrow();
  });
});
