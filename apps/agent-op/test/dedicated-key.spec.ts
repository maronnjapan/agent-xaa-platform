import { describe, expect, it } from 'vitest';
import { assertAgentBinding, AgentBindingError, resolveKeyBinding, shortIdOf } from '../src/keys/dedicated-key.js';
import { baseConfig, createFixture, exchange, newAgentId } from './helpers.js';

const DEDICATED_KEY = 'projects/p/locations/l/keyRings/idjag-signing/cryptoKeys/idjag-abcdefghijkl/cryptoKeyVersions/2';

describe('dedicated signing key', () => {
  it('uses KMS_IDJAG_KEY verbatim without building a name', () => {
    const agentId = newAgentId();
    const binding = resolveKeyBinding(baseConfig({ kmsIdjagKey: DEDICATED_KEY, agentId }));
    expect(binding.keyVersionName).toBe(DEDICATED_KEY);
    expect(binding.kidPrefix).toBe(`idjag-${shortIdOf(agentId)}`);
    expect(binding.boundAgentId).toBe(agentId);
  });

  it('uses the op-shared prefix when AGENT_ID is unset', () => {
    const binding = resolveKeyBinding(baseConfig());
    expect(binding.kidPrefix).toBe('op-shared');
    expect(binding.boundAgentId).toBeNull();
  });

  it('rejects a request for another agent when AGENT_ID is set', () => {
    const binding = resolveKeyBinding(baseConfig({ agentId: newAgentId() }));
    expect(() => assertAgentBinding(binding, newAgentId())).toThrow(AgentBindingError);
    try { assertAgentBinding(binding, newAgentId()); } catch (error) { expect((error as AgentBindingError).code).toBe('invalid_grant'); }
  });

  it('does not apply the agent binding check when AGENT_ID is unset', () => {
    expect(() => assertAgentBinding(resolveKeyBinding(baseConfig()), newAgentId())).not.toThrow();
  });

  it('returns invalid_grant over HTTP when a dedicated OP is asked for another agent', async () => {
    const otherAgent = newAgentId();
    const fixture = await createFixture({ config: { agentId: otherAgent, kmsIdjagKey: DEDICATED_KEY } });
    const response = await exchange(fixture);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('issues normally when the dedicated OP serves its own agent', async () => {
    const fixture = await createFixture();
    const bound = await createFixture({
      config: { agentId: fixture.agentId, kmsIdjagKey: DEDICATED_KEY },
      registration: { agent_id: fixture.agentId },
    });
    expect((await exchange(bound)).status).toBe(200);
  });

  it('calls no KMS create or delete API anywhere in the sources', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = new URL('../src', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = await readFile(full, 'utf8');
        for (const forbidden of ['createCryptoKey', 'destroyCryptoKeyVersion', 'createKeyRing', 'deleteCryptoKey']) {
          if (source.includes(forbidden)) offenders.push(`${full}: ${forbidden}`);
        }
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });

  it('takes the short id from the last twelve characters of the agent id', () => {
    const agentId = newAgentId();
    expect(shortIdOf(agentId)).toHaveLength(12);
    expect(agentId.endsWith(shortIdOf(agentId))).toBe(true);
  });
});
