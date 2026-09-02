import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CAPABILITIES, TOOL_IDS } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import type { VertexClient } from '../ai/authorization-ai.js';

/**
 * The seeded world, read from the files Terraform actually uploads.
 *
 * Nothing here restates a capability id or a policy: duplicating the seed in test
 * fixtures is how a test ends up proving something about data the deployment does not
 * have.
 */
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;
const seedRoot = `${repositoryRoot}infra/seed/`;

function readYaml<T>(relativePath: string): T {
  return parse(readFileSync(`${seedRoot}${relativePath}`, 'utf8')) as T;
}

export interface TaxonomyRow {
  capability_id: string;
  resource: string;
  action: string;
  description: string;
  default_characteristics?: Record<string, unknown>;
}

export interface ToolRow { tool_id: string; connector_id: string; required_capability: string }

export const TAXONOMY: TaxonomyRow[] = readYaml<TaxonomyRow[]>('capabilities.yaml');

/** Only the three columns the Policy Engine's connector map needs. */
export const TOOL_ROWS: ToolRow[] = TOOL_IDS
  .map((toolId) => readYaml<ToolRow>(`tools/${toolId}.yaml`))
  .map(({ tool_id, connector_id, required_capability }) => ({ tool_id, connector_id, required_capability }));

/**
 * Loads the taxonomy, the tool rows, one human's permissions and the three policy
 * files, the way the seed job would. Authorization itself may not write these, so a
 * seed-scoped store is passed in.
 */
export async function seedAuthorizationData(documents: DocumentStore, humanPermissions: string[], seedStore?: DocumentStore): Promise<void> {
  const seed = seedStore ?? documents;
  for (const entry of TAXONOMY) await seed.set('capability_taxonomy', entry.capability_id, { ...entry });
  for (const tool of TOOL_ROWS) await seed.set('catalog_tools', tool.tool_id, { ...tool });
  for (const capability of humanPermissions) {
    await seed.set('human_permissions', `testuser__${capability}`, {
      human_subject: 'testuser', capability_id: capability, granted_at: new Date().toISOString(),
    });
  }
  for (const entry of readYaml<Array<{ capability_id: string }>>('policies/delegatable.yaml')) {
    await seed.set('delegatable_permissions', entry.capability_id, { ...entry });
  }
  for (const policy of readYaml<Array<{ policy_id: string }>>('policies/organization.yaml')) {
    await seed.set('organization_policies', policy.policy_id, { ...policy });
  }
  for (const policy of readYaml<Array<{ policy_id: string }>>('policies/risk.yaml')) {
    await seed.set('risk_policies', policy.policy_id, { ...policy });
  }
}

/**
 * VERTEX_MODE=fake answers from `src/ai/fixtures/*.json` (T-AUTHZ-12). The path is
 * resolved from the repository root so the same file works from `src` and from `dist`,
 * whose depths differ and where JSON is not emitted.
 */
export function loadAiFixture(name: string): FakeModel {
  return JSON.parse(readFileSync(`${repositoryRoot}apps/authorization/src/ai/fixtures/${name}.json`, 'utf8')) as FakeModel;
}

export interface FakeModel {
  operations?: string[];
  targetResources?: string[];
  capabilities?: string[];
  characteristics?: Record<string, boolean>;
  confidence?: number;
  raw?: unknown;
}

/** VERTEX_MODE=fake. Two calls per decision: structure the work, then propose. */
export function createFakeVertex(model: FakeModel): VertexClient & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async generateJson<T>(): Promise<T | null> {
      calls += 1;
      if (calls === 1) {
        return { operations: model.operations ?? ['read_events'], target_resources: model.targetResources ?? ['calendar'] } as T;
      }
      if (model.raw !== undefined) return model.raw as T;
      return {
        capabilities: model.capabilities ?? [CAPABILITIES[0]],
        characteristics: model.characteristics ?? {},
        confidence: model.confidence ?? 0.9,
      } as T;
    },
  };
}
