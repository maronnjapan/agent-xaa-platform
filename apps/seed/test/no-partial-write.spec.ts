import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { PLATFORM_ENDPOINT_KEYS } from '@xaa/contracts';

/**
 * T-IAC-26 / T-IAC-27. The seed replaces seven collections, so a run that fails halfway
 * leaves the catalogue in a state no YAML file describes. The guarantee is therefore not
 * "it reports the error" but "it has not written anything when it reports the error":
 * resolution and validation both finish before Firestore is opened at all.
 *
 * The double below counts how often the Job asks for Firestore and refuses to hand one
 * over. A test that only asserted the thrown message would still pass if the deletion
 * pass had already run.
 */
const state = vi.hoisted(() => ({ files: {} as Record<string, string>, firestoreRequests: 0 }));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file: (path: string) => ({ download: async () => [Buffer.from(state.files[path] ?? '{}', 'utf8')] }),
        getFiles: async () => [
          Object.keys(state.files)
            .filter((name) => name.startsWith('seed/'))
            .map((name) => ({ name, download: async () => [Buffer.from(state.files[name]!, 'utf8')] })),
        ],
      };
    }
  },
}));

vi.mock('@xaa/gcp', () => ({
  getFirestore: () => {
    state.firestoreRequests += 1;
    throw new Error('firestore reached');
  },
}));

const { runSeed } = await import('../src/index.js');

const seedRoot = new URL('../../../infra/seed/', import.meta.url).pathname;

const endpoints = Object.fromEntries(PLATFORM_ENDPOINT_KEYS.map((key) => [
  key,
  key === 'agent_max_lifetime_seconds' ? 3600
    : key === 'enable_google_bridge' ? true
    : key === 'vertex_model' || key === 'vertex_location' ? 'test'
    : `https://${key.replaceAll('_', '-')}.test`,
]));

/** The catalogue the Job really reads, laid out the way the config bucket holds it. */
function catalogue(): Record<string, string> {
  const files: Record<string, string> = { 'platform-endpoints.json': JSON.stringify(endpoints) };
  for (const kind of ['connectors', 'tools', 'policies'] as const) {
    for (const name of readdirSync(`${seedRoot}${kind}`).filter((entry) => entry.endsWith('.yaml'))) {
      files[`seed/${kind}/${name}`] = readFileSync(`${seedRoot}${kind}/${name}`, 'utf8');
    }
  }
  files['seed/capabilities.yaml'] = readFileSync(`${seedRoot}capabilities.yaml`, 'utf8');
  files['seed/resource-sensitivity.yaml'] = readFileSync(`${seedRoot}resource-sensitivity.yaml`, 'utf8');
  return files;
}

const env = {
  SEED_BUCKET: 'demo-platform-config',
  PLATFORM_ENDPOINTS_URI: 'gs://demo-platform-config/platform-endpoints.json',
  ENABLE_GOOGLE_BRIDGE: 'true',
} as NodeJS.ProcessEnv;

beforeEach(() => {
  state.files = catalogue();
  state.firestoreRequests = 0;
});

describe('the seed Job on bad input', () => {
  it('names the unresolved placeholder and never opens Firestore', async () => {
    const path = 'seed/tools/internal.document.get.yaml';
    state.files[path] = state.files[path]!.replace('${resource:docs}', '${resource:unknown}');

    await expect(runSeed(env)).rejects.toThrow(/unresolved seed placeholders: resource:unknown/);
    expect(state.firestoreRequests).toBe(0);
  });

  it('reports the schema violation and never opens Firestore', async () => {
    const path = 'seed/tools/internal.document.get.yaml';
    state.files[path] = state.files[path]!.replace('method: GET', 'method: FETCH');

    await expect(runSeed(env)).rejects.toThrow(/api\.method/);
    expect(state.firestoreRequests).toBe(0);
  });

  /**
   * Without this, the two assertions above would also hold for a Job that never reaches
   * Firestore at all — including one that is broken outright.
   */
  it('does reach Firestore once the same catalogue validates', async () => {
    await expect(runSeed(env)).rejects.toThrow(/firestore reached/);
    expect(state.firestoreRequests).toBe(1);
  });
});
