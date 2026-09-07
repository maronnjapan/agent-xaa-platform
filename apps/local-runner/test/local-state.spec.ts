import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Timestamp } from '@xaa/gcp';
import { loadLocalConfig } from '../src/config.js';
import { createLocalObjectStore } from '../src/local/object-store.js';
import { createEphemeralState, decode, encode, openLocalState } from '../src/local/state.js';
import { shouldSeed } from '../src/runner.js';
import { endAgentsFromPreviousRun } from '../src/services/recover.js';
import { createLocalPlatform } from '../src/platform.js';

/**
 * The state directory, checked on the properties a restarted platform depends on.
 *
 * Each of these is a way a run could come back subtly wrong rather than obviously
 * broken: an expiry that reads as an ordinary object, a KMS key that is not the one the
 * rows were encrypted with, half a file left by a process that was killed.
 */
describe('the local state directory', () => {
  let directory: string;

  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'xaa-state-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('is fresh the first time and not the second', () => {
    const first = openLocalState(directory);
    expect(first.fresh).toBe(true);
    expect(first.rows).toBeUndefined();
    first.save(() => ({ documents: { 'doc-1': { title: 'report' } } }));
    first.flush();

    const second = openLocalState(directory);
    expect(second.fresh).toBe(false);
    expect(second.rows).toEqual({ documents: { 'doc-1': { title: 'report' } } });
  });

  /**
   * The one value JSON cannot carry on its own. `expireAt` is a Timestamp on every
   * stored token in the platform, and a run that read it back as `{}` would treat every
   * one of them as unexpired forever.
   */
  it('gives back a Timestamp as a Timestamp', () => {
    const first = openLocalState(directory);
    first.save(() => ({ oidc_human_idp: { 'token-1': { expireAt: Timestamp.fromMillis(1_800_000_000_000) } } }));
    first.flush();

    const stored = openLocalState(directory).rows!.oidc_human_idp!['token-1']!.expireAt;
    expect(stored).toBeInstanceOf(Timestamp);
    expect((stored as Timestamp).toMillis()).toBe(1_800_000_000_000);
  });

  it('gives back bytes as bytes, wherever they are nested', () => {
    const value = { outer: [{ inner: Buffer.from('ciphertext', 'utf8') }] };
    const back = decode(JSON.parse(JSON.stringify(encode(value)))) as typeof value;
    expect(Buffer.from(back.outer[0]!.inner).toString('utf8')).toBe('ciphertext');
  });

  it('keeps the KMS master key, so what one run encrypted the next one can read', () => {
    const first = openLocalState(directory);
    expect(first.kmsMasterSecret).toHaveLength(32);
    expect(openLocalState(directory).kmsMasterSecret.equals(first.kmsMasterSecret)).toBe(true);
  });

  it('leaves the directory and its files to their owner', () => {
    const state = openLocalState(directory);
    state.save(() => ({}));
    state.flush();
    expect(statSync(directory).mode & 0o077).toBe(0);
    expect(statSync(join(directory, 'firestore.json')).mode & 0o077).toBe(0);
    expect(statSync(join(directory, 'kms-master.key')).mode & 0o077).toBe(0);
  });

  /**
   * A file this version cannot read starts the platform over rather than stopping it.
   * What is in it is a demo's ToDos and documents; refusing to boot over them would
   * cost more than they are worth.
   */
  it('starts over on a file it cannot read, seed and all', () => {
    for (const body of ['{"version":999,"collections":{}}', 'not json at all']) {
      writeFileSync(join(directory, 'firestore.json'), body);
      const state = openLocalState(directory);
      expect(state.rows).toBeUndefined();
      // Not just empty rows: `fresh` is what decides whether the seed runs, and a
      // platform that read nothing and seeded nothing would grant no tool anything.
      expect(state.fresh).toBe(true);
    }
  });

  it('coalesces a burst of writes into one file, and loses none of it on the way out', () => {
    const state = openLocalState(directory);
    for (let index = 0; index < 50; index += 1) {
      state.save(() => ({ documents: { 'doc-1': { version: index } } }));
    }
    // Nothing has been written yet: the burst is still inside the debounce window.
    expect(() => readFileSync(join(directory, 'firestore.json'), 'utf8')).toThrow();
    state.flush();
    const written = JSON.parse(readFileSync(join(directory, 'firestore.json'), 'utf8')) as {
      collections: { documents: { 'doc-1': { version: number } } };
    };
    expect(written.collections.documents['doc-1'].version).toBe(49);
  });

  it('keeps nothing when there is nowhere to keep it', () => {
    const state = createEphemeralState();
    expect(state.directory).toBeUndefined();
    expect(state.fresh).toBe(true);
    expect(state.rows).toBeUndefined();
    expect(() => { state.save(() => ({})); state.flush(); }).not.toThrow();
  });
});

/**
 * The bucket `bootstrapSigningKey` writes the wrapped SSO key into. Its one demanding
 * property is the create-if-absent precondition: without it, two cold starts racing for
 * the first key end with two keys, one of which nothing can verify against.
 */
describe('the local object store', () => {
  let directory: string;

  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'xaa-bucket-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  for (const [label, make] of [
    ['on disk', () => createLocalObjectStore(directory)],
    ['in memory', () => createLocalObjectStore()],
  ] as const) {
    it(`answers null for an object that is not there, and refuses to replace one that is (${label})`, async () => {
      const store = make();
      expect(await store.read('sso-signing/current.json')).toBeNull();
      await store.createIfAbsent('sso-signing/current.json', '{"kid":"idp-aaaaaaaa"}');
      expect(await store.read('sso-signing/current.json')).toBe('{"kid":"idp-aaaaaaaa"}');
      await expect(store.createIfAbsent('sso-signing/current.json', '{"kid":"idp-bbbbbbbb"}'))
        .rejects.toMatchObject({ code: 412 });
      expect(await store.read('sso-signing/current.json')).toBe('{"kid":"idp-aaaaaaaa"}');
    });
  }

  it('refuses an object name that reaches outside the bucket', async () => {
    const store = createLocalObjectStore(directory);
    await expect(store.read('../kms-master.key')).rejects.toThrow(/invalid object name/);
    await expect(store.write('/etc/passwd', 'no')).rejects.toThrow(/invalid object name/);
  });
});

describe('when the seed runs', () => {
  it('writes on a platform that starts from nothing, and not over one that did not', () => {
    expect(shouldSeed('auto', true)).toBe(true);
    expect(shouldSeed('auto', false)).toBe(false);
    expect(shouldSeed('always', false)).toBe(true);
    expect(shouldSeed('never', true)).toBe(false);
  });

  it('is read from LOCAL_SEED the way it always was, with unset now meaning auto', () => {
    expect(loadLocalConfig({}).seed).toBe('auto');
    expect(loadLocalConfig({ LOCAL_SEED: 'true' }).seed).toBe('always');
    expect(loadLocalConfig({ LOCAL_SEED: 'false' }).seed).toBe('never');
  });

  it('persists by default, and nowhere when asked not to', () => {
    expect(loadLocalConfig({}).stateDir).toMatch(/\.local\/state$/);
    expect(loadLocalConfig({ LOCAL_STATE_DIR: '/tmp/xaa-somewhere' }).stateDir).toBe('/tmp/xaa-somewhere');
    expect(loadLocalConfig({ LOCAL_PERSIST: 'false' }).stateDir).toBeUndefined();
  });
});

/**
 * An agent's credentials do not outlive the process that held them, so neither may the
 * agent. What the restored rows describe is ended through the Lifecycle Manager's own
 * cleanup, and the platform starts with nothing pretending to be running.
 */
describe('the agents a previous run left', () => {
  it('are ended, and the ones already destroyed are left alone', async () => {
    const config = loadLocalConfig({ LOCAL_PERSIST: 'false', LOCAL_QUIET: 'true' });
    const platform = await createLocalPlatform(config, { model: { async generateJson() { return null; } } });
    for (const [id, status] of [['agent-a', 'ACTIVE'], ['agent-b', 'PROVISIONING'], ['agent-c', 'DESTROYED']]) {
      await platform.firestore.collection('agents').doc(`${id}__meta`).set({ agent_id: id, status });
    }
    // Neither of these is the meta document, and therefore neither is an agent. The
    // manifest carries `agent_id`, so a scan that went by the field rather than by the
    // document would end `agent-a` twice.
    await platform.firestore.collection('agents').doc('agent-a__state').set({ checkpoint: 'thinking' });
    await platform.firestore.collection('agents').doc('agent-a__manifest').set({ agent_id: 'agent-a', tools: [] });

    const ended: Array<[string, string]> = [];
    const endedIds = await endAgentsFromPreviousRun(platform, async (agentId, reason) => {
      ended.push([agentId, reason]);
      return undefined;
    });

    expect(endedIds).toEqual(['agent-a', 'agent-b']);
    expect(ended).toEqual([['agent-a', 'EXPIRED'], ['agent-b', 'EXPIRED']]);
    await platform.shutdown();
  });

  it('does not stop the platform starting when one of them cannot be ended', async () => {
    const config = loadLocalConfig({ LOCAL_PERSIST: 'false', LOCAL_QUIET: 'true' });
    const platform = await createLocalPlatform(config, { model: { async generateJson() { return null; } } });
    await platform.firestore.collection('agents').doc('agent-a__meta').set({ agent_id: 'agent-a', status: 'ACTIVE' });

    await expect(endAgentsFromPreviousRun(platform, async () => { throw new Error('the OP is not there'); }))
      .resolves.toEqual(['agent-a']);
    await platform.shutdown();
  });
});
