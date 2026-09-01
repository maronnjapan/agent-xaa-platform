import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRuntimeName, dedicatedNames, ForbiddenRuntimeName, RUNTIME_NAME_PREFIXES, shortId } from '@xaa/contracts';
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
    const callers = (await sources())
      .filter((file) => !file.path.includes('/testing/') && file.text.includes('deps.createDedicated('));
    expect(callers.map((file) => file.path.split('/src/')[1])).toEqual(['provisioning/flow.ts']);
    const lines = callers[0]!.text.split('\n');
    // The step that creates them is only put into the run for a full_isolation
    // request, so the guard has to come first in the file as well as at run time.
    const guard = lines.findIndex((line) => line.includes("request.isolationLevel === 'full_isolation' ?"));
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

  /**
   * 00b §3 puts one writer in front of `agents/{agent_id}/meta`. The rule is not about
   * tidiness: Lifecycle owns the status field after provisioning ends, and a second
   * writer here is how a registration starts disagreeing with the agent it describes.
   */
  it('writes the agent registration from one module only', async () => {
    const offenders = (await sources())
      .filter((file) => !file.path.endsWith('agent/registration.ts'))
      .filter((file) => /\.(set|update|delete)\(\s*'agents',[^)]*__meta/.test(file.text));
    expect(offenders.map((file) => file.path.split('/src/')[1])).toEqual([]);
  });

  it('writes no other sub-document of an agent from outside its own owner', async () => {
    const owners: Record<string, string> = { __meta: 'agent/registration.ts', __manifest: 'agent/registration.ts', __baseline: 'baseline-hook.ts' };
    for (const [suffix, owner] of Object.entries(owners)) {
      const writers = (await sources())
        .filter((file) => new RegExp(`\\.(set|update|delete)\\(\\s*'agents',[^)]*${suffix}`).test(file.text))
        .map((file) => file.path.split('/src/')[1]);
      expect(writers).toEqual([owner]);
    }
  });

  it('passes the runtime mutation scope check', () => {
    expect(() => execFileSync('bash', ['infra/tests/runtime-mutation-scope.sh'], { cwd: repoRoot })).not.toThrow();
  });
});
