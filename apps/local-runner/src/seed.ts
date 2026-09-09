import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { runSeed } from 'seed/src/index';
import type { LocalPlatform } from './platform.js';

/**
 * Walks up to the repository's `infra/seed`, so the same code works from `src` and from
 * `dist`, whose depths differ.
 */
async function findSeedRoot(): Promise<string> {
  let directory = new URL('.', import.meta.url).pathname;
  for (let step = 0; step < 8; step += 1) {
    try {
      await readdir(join(directory, 'infra/seed/tools'));
      return join(directory, 'infra/seed');
    } catch {
      directory = join(directory, '..');
    }
  }
  throw new Error('infra/seed not found');
}

async function readYamlTree(root: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.yaml')) contents.set(relative(root, path), await readFile(path, 'utf8'));
    }
  };
  await walk(root);
  return contents;
}

/**
 * The seed Job, run from the files in the checkout.
 *
 * On GCP the same YAML is uploaded to the platform config bucket and a Cloud Run Job
 * reads it from there; the reading is the only part that differs. Everything that
 * decides what the platform knows — which connectors and tools exist, what the
 * capability taxonomy says, who holds which permission, and the demo documents and
 * payments the guide's first step needs — comes from `runSeed`, so a local platform
 * starts with the catalogue the deployed one starts with.
 *
 * It runs on a platform that starts from nothing, because an unseeded one answers every
 * provisioning with "no tool grants that capability". It does not run again over rows a
 * previous run left: the collections it writes are the ones it first empties, and among
 * them is `human_permissions` — so a second pass would take back the permissions granted
 * since (`shouldSeed` in runner.ts decides, and `LOCAL_SEED=true` asks for it anyway).
 */
export async function runLocalSeed(platform: LocalPlatform): Promise<void> {
  const root = await findSeedRoot();
  const { projectId, bridgeEnabled, endpoints } = platform.config.topology;
  await runSeed(
    {
      PROJECT_ID: projectId,
      ENABLE_GOOGLE_BRIDGE: String(bridgeEnabled),
      SAAS_CONNECTOR_MODE: 'stub',
      STUB_BRIDGE_SECRET_ID: `projects/${projectId}/secrets/stub-bridge-client-secret`,
      GOOGLE_OAUTH_SECRET_ID: `projects/${projectId}/secrets/google-oauth-client-secret`,
    },
    {
      readEndpoints: async () => endpoints,
      readSeedFiles: () => readYamlTree(root),
      firestore: platform.firestore,
    },
  );
}
