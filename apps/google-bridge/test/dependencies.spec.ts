import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { InMemoryJtiStore } from '@xaa/crypto';
import createApp, { type BridgeDeps } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { testConfig } from '../src/testing/harness.js';

/**
 * What the Bridge is allowed to depend on.
 *
 * docs 06 §2 lists what the Bridge does not do — call business APIs, run a model, proxy
 * anything. Prose does not stop a later change from adding an SDK that makes one of
 * those easy, so the dependency set is pinned instead: a Vertex client, an HTTP proxy
 * or a second fetch library cannot arrive without this test going red.
 *
 * Three entries differ from T-BRIDGE-01's list, each for a reason visible in the
 * manifest: `@google-cloud/firestore` is reached through `@xaa/gcp` rather than
 * directly, `@xaa/logging` is the shared log envelope every service writes through
 * (00b §1), and `@xaa/stub-saas-op` is the in-process SaaS the test harness routes to.
 */
const ALLOWED_DEPENDENCIES = [
  '@google-cloud/kms',
  '@google-cloud/secret-manager',
  '@hono/node-server',
  '@maronn-openid-connect/experimental',
  '@xaa/contracts',
  '@xaa/crypto',
  '@xaa/gcp',
  '@xaa/logging',
  '@xaa/stub-saas-op',
  'ajv',
  'ajv-formats',
  'hono',
];

async function manifest(): Promise<{ dependencies: Record<string, string> }> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
}

describe('dependencies allowlist', () => {
  it('matches the manifest exactly', async () => {
    expect(Object.keys((await manifest()).dependencies).sort()).toEqual([...ALLOWED_DEPENDENCIES].sort());
  });

  it('would go red on a model client, a proxy or a second HTTP library', async () => {
    const actual = Object.keys((await manifest()).dependencies).sort();
    for (const forbidden of ['@google-cloud/vertexai', '@xaa/vertex', 'http-proxy', 'node-fetch', 'axios', 'got']) {
      // The assertion above is an equality, so any addition breaks it. This states the
      // consequence for the packages the requirement names, so the reason survives.
      expect([...actual, forbidden].sort()).not.toEqual([...ALLOWED_DEPENDENCIES].sort());
      expect(actual).not.toContain(forbidden);
    }
  });
});

describe('the face is a required setting', () => {
  const deps = (face: unknown): BridgeDeps => ({
    config: { ...testConfig, face: face as typeof testConfig.face },
    documents: createFirestoreDocumentStore(createFirestoreDouble(), 'google-bridge'),
    jtiStore: new InMemoryJtiStore(),
    kms: {
      async encrypt(_keyName, plaintext) { return plaintext; },
      async decrypt(_keyName, ciphertext) { return ciphertext; },
    },
    readSecret: async () => 'secret',
  });

  it('throws when BRIDGE_FACE is unset', () => {
    // Both halves of the path a deployment takes: the environment is read here...
    expect(() => loadConfig({ SHARED_ISSUER: 'https://idp.test' })).toThrow(/BRIDGE_FACE/);
    // ...and the app refuses to be built from a config that never got a face, rather
    // than quietly serving the callback half.
    expect(() => createApp(deps(undefined))).toThrow(/BRIDGE_FACE/);
    expect(() => createApp(deps('both'))).toThrow(/BRIDGE_FACE/);
  });

  it('builds either face when it is set', () => {
    expect(typeof createApp(deps('internal')).fetch).toBe('function');
    expect(typeof createApp(deps('callback')).fetch).toBe('function');
  });
});
