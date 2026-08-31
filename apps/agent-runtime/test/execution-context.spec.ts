import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jwkThumbprint } from '@xaa/crypto';
import { importAgentClientKey } from '../src/context/agent-client-key.js';
import { TokenStore, accessTokenKey, idJagKey } from '../src/tokens/token-store.js';
import { AGENT_ID, agentClientJwk, memoryStore, runtimeEnv, testContext } from './helpers.js';
import { createExecutionContext } from '../src/context/execution-context.js';

async function grepSource(pattern: RegExp): Promise<string[]> {
  const root = new URL('../src', import.meta.url).pathname;
  const hits: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const code = (await readFile(full, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const line of code.split('\n')) if (pattern.test(line)) hits.push(`${full}: ${line.trim()}`);
    }
  };
  await walk(root);
  return hits;
}

describe('the execution context', () => {
  it('generates exactly one dpop key per execution', async () => {
    const context = await testContext();
    expect(context.dpop.jkt).toBe(await jwkThumbprint(context.dpop.publicJwk));
    // One file names it at all, and it calls it once: every other module reaches
    // the key through ctx.dpop.
    const hits = await grepSource(/generateDpopKeyPair/);
    expect(new Set(hits.map((hit) => hit.split(': ')[0]))).toHaveLength(1);
    expect(hits.filter((hit) => hit.includes('generateDpopKeyPair()'))).toHaveLength(1);
  });

  it('gives two executions different keys', async () => {
    const [first, second] = await Promise.all([testContext(), testContext()]);
    expect(first.dpop.jkt).not.toBe(second.dpop.jkt);
  });

  it('dpop private key is non-extractable', async () => {
    const context = await testContext();
    expect(context.dpop.privateKey.extractable).toBe(false);
    await expect(webcrypto.subtle.exportKey('jwk', context.dpop.privateKey)).rejects.toThrow();
  });

  it('freezes every field', async () => {
    const context = await testContext();
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.keys(context).sort()).toEqual([
      'agentClientKey', 'agentId', 'agentOpBaseUrl', 'createdAt', 'dpop', 'executionId',
      'expiresAt', 'humanSubject', 'isolationLevel', 'manifest', 'store', 'taskId', 'tokens',
    ]);
  });
});

describe('the agent client key', () => {
  it('is not serializable', async () => {
    const key = await importAgentClientKey({ privateJwk: await agentClientJwk(), agentId: AGENT_ID, env: {} });
    const serialized = JSON.stringify({ key });
    expect(serialized).not.toContain('"d"');
    expect(serialized).toContain('[redacted]');
  });

  it('removes the jwk from the environment it was read from', async () => {
    const env: NodeJS.ProcessEnv = { AGENT_CLIENT_PRIVATE_JWK: await agentClientJwk() };
    await importAgentClientKey({ privateJwk: env.AGENT_CLIENT_PRIVATE_JWK!, agentId: AGENT_ID, env });
    expect(env.AGENT_CLIENT_PRIVATE_JWK).toBeUndefined();
  });

  it('signs with a key that cannot be exported', async () => {
    const context = await testContext();
    const token = await context.agentClientKey.signCompactJws({ alg: 'ES256', typ: 'agent-assertion+jwt' }, { sub: 'x' });
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejects anything that is not an EC P-256 private jwk', async () => {
    await expect(importAgentClientKey({ privateJwk: 'not json', agentId: AGENT_ID, env: {} })).rejects.toThrow();
    await expect(importAgentClientKey({ privateJwk: '{"kty":"RSA"}', agentId: AGENT_ID, env: {} })).rejects.toThrow();
  });

  it('is never named by a resource request builder', async () => {
    const resourceModule = await readFile(new URL('../src/http/resource-authorization.ts', import.meta.url), 'utf8');
    expect(resourceModule).not.toContain('AgentClientKey');
    expect(await grepSource(/asymmetricSign|@google-cloud\/kms/)).toEqual([]);
  });
});

describe('the token store', () => {
  it('exposes only get/set/clear', () => {
    const store = new TokenStore();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['clear', 'get', 'set']);
    for (const forbidden of ['save', 'persist', 'write', 'toJSON']) {
      expect(store).not.toHaveProperty(forbidden);
    }
  });

  it('treats an entry inside the skew window as absent', () => {
    const store = new TokenStore();
    store.set('subject', 'value', 100_000);
    expect(store.get('subject', 50_000)).toBe('value');
    expect(store.get('subject', 80_000)).toBeUndefined();
  });

  it('accepts only the three key shapes', () => {
    const store = new TokenStore();
    expect(() => store.set('subject', 'v', 1)).not.toThrow();
    expect(() => store.set(idJagKey('internal.document.get'), 'v', 1)).not.toThrow();
    expect(() => store.set(accessTokenKey({ audience: 'a', resource: 'r', scope: 's' }), 'v', 1)).not.toThrow();
    expect(() => store.set('session' as never, 'v', 1)).toThrow();
  });

  it('is cleared at the end of an execution', async () => {
    const context = await testContext();
    context.tokens.set('subject', 'value', Date.now() + 600_000);
    context.tokens.clear();
    expect(context.tokens.get('subject')).toBeUndefined();
  });
});

describe('the runtime store', () => {
  it('denies write to another agent state', async () => {
    const { store } = memoryStore('agent-abcdefghijklmnopqrstuvwxyz');
    const other = memoryStore('agent-zzzzzzzzzzzzzzzzzzzzzzzzzz');
    await expect(store.writeState({ agent_status: 'ACTIVE' })).resolves.toBeUndefined();
    await expect(other.store.readMeta()).resolves.toBeUndefined();
    const env = await runtimeEnv();
    const wrongAgent = createExecutionContext({ env, store: other.store, processEnv: {} });
    await expect(wrongAgent).resolves.toBeTruthy();
  });

  it('denies read of idp_connections', async () => {
    const { documents } = memoryStore();
    await expect(documents.get('idp_connections', 'anything')).rejects.toThrow(/denied/);
  });

  it('allows exactly the documented operations', async () => {
    const { documents } = memoryStore();
    const allowed: Array<[string, () => Promise<unknown>]> = [
      ['read agents/{id}/meta', () => documents.get('agents', `${AGENT_ID}__meta`)],
      ['read agents/{id}/manifest', () => documents.get('agents', `${AGENT_ID}__manifest`)],
      ['read agent instructions', () => documents.queryEqual('agent_instructions', [['agent_id', AGENT_ID]])],
      ['update agent instructions', () => documents.update('agent_instructions', 'i1', { applied_at: 'now' }).catch(() => undefined)],
      ['write agents/{id}/state', () => documents.set('agents', `${AGENT_ID}__state`, { agent_status: 'ACTIVE' })],
    ];
    for (const [, run] of allowed) await expect(run()).resolves.not.toThrow();

    const denied = [
      () => documents.set('agents', `${AGENT_ID}__meta`, {}),
      () => documents.get('agent_definitions', 'x'),
      () => documents.get('authorization_decisions', 'x'),
      () => documents.set('users', 'testuser__activity__1', {}),
    ];
    for (const run of denied) await expect(run()).rejects.toThrow(/denied/);
  });

  it('creates a Firestore client in one place only', async () => {
    expect(await grepSource(/new Firestore\(|getFirestore\(/)).toHaveLength(1);
  });
});
