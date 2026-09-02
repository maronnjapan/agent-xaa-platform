import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore, type Firestore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { CAPABILITIES, type ActivityEvent, type Characteristics } from '@xaa/contracts';
import createApp, { type AuthorizationDeps } from '../src/app.js';
import type { AuthorizationConfig } from '../src/config.js';
import { decide, type DecisionRecord, type DecisionStep } from '../src/pipeline/decide.js';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import type { ReprovisionRequest } from '../src/reevaluate/reprovision-client.js';
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

export const DEFAULT_CHARACTERISTICS: Characteristics = {
  capability_risk: 'low', sensitive_resource: false, write_operation: false,
  admin_permission: false, external_communication: false, financial_operation: false,
  personal_data_access: true,
};

export interface AuthzHarness {
  documents: DocumentStore;
  /** Writes the collections Authorization may only read, the way another app would. */
  foreign(app: string): DocumentStore;
  steps: DecisionStep[];
  logs: string[];
  activity: Array<Record<string, unknown>>;
  reprovisions: ReprovisionRequest[];
  vertex: { calls: number };
  deps: AuthorizationDeps;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export async function createAuthzHarness(options: {
  humanPermissions?: string[];
  model?: FakeModel;
  config?: Partial<AuthorizationConfig>;
  now?: () => number;
  /** Makes every activity publish fail, to check the decision survives it. */
  failActivityPublish?: boolean;
  reprovisionFails?: boolean;
} = {}): Promise<AuthzHarness> {
  const firestore: Firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(documents, options.humanPermissions ?? [...CAPABILITIES], createFirestoreDocumentStore(firestore, 'seed'));
  const steps: DecisionStep[] = [];
  const logs: string[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const reprovisions: ReprovisionRequest[] = [];
  const vertex = createFakeVertex(options.model ?? {});
  const deps: AuthorizationDeps = {
    config: { ...testConfig, ...options.config },
    documents,
    vertex,
    logger: createLogger('authorization', 'policy_engine', (line) => { logs.push(line); }),
    recordStep: (step) => steps.push(step),
    ...(options.now ? { clock: { now: options.now } } : {}),
    publishActivity: async (event) => {
      if (options.failActivityPublish) throw new Error('topic unavailable');
      activity.push(event);
    },
    requestReprovision: async (request) => {
      reprovisions.push(request);
      if (options.reprovisionFails) throw new Error('lifecycle unavailable');
    },
  };
  const app = createApp(deps);
  return {
    documents, steps, logs, activity, reprovisions, vertex, deps,
    foreign: (app_) => createFirestoreDocumentStore(firestore, app_),
    fetch: (path, init) => app.fetch(new Request(new URL(path, AUTHZ_BASE), init)),
  };
}

/** The structured log lines the app wrote, parsed. */
export function logLines(harness: AuthzHarness): Array<{ event: string; severity: string; fields: Record<string, unknown> }> {
  return harness.logs.map((line) => JSON.parse(line) as { event: string; severity: string; fields: Record<string, unknown> });
}

export function activityEvents(harness: AuthzHarness): ActivityEvent[] {
  return harness.activity as unknown as ActivityEvent[];
}

/**
 * Writes `agents/{agent_id}/meta` as the Provisioner would. Authorization may only
 * read that collection, so the seed has to come through another app's store.
 */
export async function seedAgent(harness: AuthzHarness, agent: {
  agentId: string;
  humanSubject: string;
  status: string;
  createdAt: string;
}): Promise<void> {
  await harness.foreign('provisioner').set('agents', `${agent.agentId}__meta`, {
    agent_id: agent.agentId,
    human_subject: agent.humanSubject,
    status: agent.status,
    created_at: agent.createdAt,
    expires_at: new Date(Date.parse(agent.createdAt) + 3_600_000).toISOString(),
    isolation_level: 'standard',
  });
}

/** A decision and the proposal it came from, as one earlier request would have left them. */
export async function seedDecision(harness: AuthzHarness, input: {
  decisionId: string;
  humanSubject: string;
  proposed: string[];
  effective: string[];
  createdAt: string;
  workDefinitionId?: string;
  characteristics?: Characteristics;
}): Promise<void> {
  await harness.documents.set('authorization_decisions', input.decisionId, {
    decision_id: input.decisionId,
    status: 'decided',
    human_subject: input.humanSubject,
    work_definition_id: input.workDefinitionId ?? `wd_${input.decisionId}`,
    proposed_capabilities: input.proposed,
    effective_capabilities: input.effective,
    security_profile: { risk_score: 0, isolation_level: 'standard', reasons: [] },
    denied: [], dropped_out_of_taxonomy: [], constraints: {},
    created_at: input.createdAt,
  });
  await harness.documents.set('ai_proposals', `prop_${input.decisionId}`, {
    decision_id: input.decisionId,
    work_definition_id: input.workDefinitionId ?? `wd_${input.decisionId}`,
    proposed_capabilities: input.proposed,
    characteristics: input.characteristics ?? DEFAULT_CHARACTERISTICS,
    confidence: 0.9,
    taxonomy_version: 'v1',
    model_version: 'gemini-2.5-flash',
    created_at: input.createdAt,
  });
}

/** The Pub/Sub push envelope the subscription delivers. */
export function pushBody(payload: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } }),
  };
}

/** One row per (subject, capability), the way the seed job writes them. */
export async function seedHumanPermissions(harness: AuthzHarness, humanSubject: string, capabilities: string[]): Promise<void> {
  const seed = harness.foreign('seed');
  for (const capability of capabilities) {
    await seed.set('human_permissions', `${humanSubject}__${capability}`, {
      human_subject: humanSubject, capability_id: capability, granted_at: '2026-03-01T00:00:00.000Z',
    });
  }
}

/** Removes one grant, as `pnpm perm:set <subject> <capability> revoke` would. */
export async function revokeHumanPermission(harness: AuthzHarness, humanSubject: string, capability: string): Promise<void> {
  await harness.foreign('seed').delete('human_permissions', `${humanSubject}__${capability}`);
}

export interface DecisionRun {
  record: DecisionRecord;
  activity: ActivityEvent[];
  logs: string[];
  documents: DocumentStore;
}

/**
 * One decision, taken through the real pipeline with the seeded policy data. The API
 * edge is skipped deliberately: what these specs are about is what the pipeline writes
 * and publishes, and the token chain is fixed by the route-surface specs.
 */
export async function runDecision(options: {
  humanPermissions: string[];
  model?: FakeModel;
  failPublish?: boolean;
  description?: string;
}): Promise<DecisionRun> {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(documents, options.humanPermissions, createFirestoreDocumentStore(firestore, 'seed'));
  const activity: ActivityEvent[] = [];
  const logs: string[] = [];
  const record = await decide({
    humanSubject: 'testuser', purpose: '支払い確認',
    description: options.description ?? '支払いを確認する',
    constraints: {}, requestedLifetimeHours: 8,
  }, {
    store: createAuthorizationStore(documents),
    vertex: createFakeVertex(options.model ?? {}),
    clock: { now: () => Date.parse('2026-03-01T00:00:00Z') },
    modelVersion: testConfig.vertexModel, taxonomyVersion: testConfig.taxonomyVersion,
    logger: createLogger('authorization', 'policy_engine', (line) => { logs.push(line); }),
    publishActivity: async (event) => {
      if (options.failPublish) throw new Error('topic unavailable');
      activity.push(event as ActivityEvent);
    },
  });
  return { record, activity, logs, documents };
}
