import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { CAPABILITIES } from '@xaa/contracts';
import createApp, { type AuthorizationDeps } from '../src/app.js';
import type { AuthorizationConfig } from '../src/config.js';
import type { DecisionStep } from '../src/pipeline/decide.js';
import { createFakeVertex, seedAuthorizationData, TAXONOMY, TOOL_ROWS, type FakeModel } from '../src/testing/fixtures.js';

export { createFakeVertex, seedAuthorizationData, TAXONOMY, TOOL_ROWS };
export type { FakeModel };

export const AUTHZ_ISSUER = 'https://human-idp.test';
export const AUTHZ_BASE = 'https://authorization.test';

export const testConfig: AuthorizationConfig = {
  port: 8080, issuer: AUTHZ_ISSUER, jwksUrl: 'https://storage.test/jwks.json',
  authzAudience: 'authorization-platform', authzPublicBaseUrl: AUTHZ_BASE,
  projectId: 'xaa-test', region: 'asia-northeast1',
  storeMode: 'emulator', pubsubMode: 'inproc', vertexMode: 'fake',
  vertexModel: 'gemini-2.5-flash', vertexLocation: 'us-central1',
  dpopIatSkewSeconds: 60, dpopJtiTtlSeconds: 120,
  lifecycleManagerUrl: 'https://lifecycle.test', activityTopic: 'agent-activity-stream',
  taxonomyVersion: 'v1', agentMaxLifetimeSeconds: 86_400,
};

export interface AuthzHarness {
  documents: DocumentStore;
  steps: DecisionStep[];
  logs: string[];
  activity: Array<Record<string, unknown>>;
  deps: AuthorizationDeps;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export async function createAuthzHarness(options: {
  humanPermissions?: string[];
  model?: FakeModel;
  config?: Partial<AuthorizationConfig>;
} = {}): Promise<AuthzHarness> {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(documents, options.humanPermissions ?? [...CAPABILITIES], createFirestoreDocumentStore(firestore, 'seed'));
  const steps: DecisionStep[] = [];
  const logs: string[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const deps: AuthorizationDeps = {
    config: { ...testConfig, ...options.config },
    documents,
    vertex: createFakeVertex(options.model ?? {}),
    logger: createLogger('authorization', 'policy_engine', (line) => { logs.push(line); }),
    recordStep: (step) => steps.push(step),
    publishActivity: async (event) => { activity.push(event); },
  };
  const app = createApp(deps);
  return {
    documents, steps, logs, activity, deps,
    fetch: (path, init) => app.fetch(new Request(new URL(path, AUTHZ_BASE), init)),
  };
}
