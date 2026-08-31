import { InMemoryJtiStore } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import type { CatalogConnector, CatalogTool, IsolationLevel } from '@xaa/contracts';
import createApp, { type ProvisionerAppDeps } from '../src/app.js';
import { createTransactionStore } from '../src/transaction/store.js';
import type { DedicatedResult, GcpAdmin } from '../src/dedicated.js';
import type { ProvisionerConfig } from '../src/deps.js';

export const PROVISIONER_BASE = 'https://provisioner.test';
export const HUMAN_IDP_ISSUER = 'https://human-idp.test';

const seedRoot = new URL('../../../infra/seed/', import.meta.url).pathname;

/** The seeded catalogue, with the Terraform placeholders resolved to test URLs. */
function resolvePlaceholders(text: string): string {
  return text
    .replaceAll('${issuer:docs}', 'https://resource-docs-as.test')
    .replaceAll('${resource:docs}', 'https://resource-docs-api.test')
    .replaceAll('${issuer:finance}', 'https://resource-finance-as.test')
    .replaceAll('${resource:finance}', 'https://resource-finance-api.test')
    .replaceAll('${issuer:stub}', 'https://stub-saas-op.test')
    .replaceAll('${resource:stub}', 'https://stub-saas-api.test')
    .replaceAll('${bridge:internal}', 'https://google-bridge.test');
}

export function seededTools(): CatalogTool[] {
  return readdirSync(`${seedRoot}tools`)
    .map((file) => parse(resolvePlaceholders(readFileSync(`${seedRoot}tools/${file}`, 'utf8'))) as CatalogTool);
}

export function seededConnectors(): CatalogConnector[] {
  return readdirSync(`${seedRoot}connectors`)
    .map((file) => parse(resolvePlaceholders(readFileSync(`${seedRoot}connectors/${file}`, 'utf8'))) as CatalogConnector);
}

export const testConfig: ProvisionerConfig = {
  port: 8080,
  issuer: HUMAN_IDP_ISSUER,
  jwksUrl: 'https://storage.test/xaa-jwks/jwks.json',
  audience: 'agent-provisioner',
  publicBaseUrl: PROVISIONER_BASE,
  sharedAgentOpUrl: 'https://shared-agent-op.test',
  standardJobName: 'projects/xaa-test/locations/asia-northeast1/jobs/agent-runtime-standard',
  agentMaxLifetimeSeconds: 86_400,
  maxFullIsolationAgents: 5,
  activityTopic: 'agent-activity-stream',
  dpopIatSkewSeconds: 60,
};

export interface AdminCall { method: string; name: string }

/** Records every GCP admin call so a STANDARD run can be shown to make none. */
export function recordingAdmin(options: { failAt?: string } = {}): GcpAdmin & { calls: AdminCall[] } {
  const calls: AdminCall[] = [];
  const record = (method: string, name: string) => {
    calls.push({ method, name });
    if (options.failAt === method) throw new Error(`${method} failed`);
  };
  return {
    calls,
    async createServiceAccount(input) {
      record('createServiceAccount', input.accountId);
      return `serviceAccount:${input.accountId}@xaa-test.iam.gserviceaccount.com`;
    },
    async createCryptoKey(input) {
      record('createCryptoKey', input.keyId);
      return `${input.keyRing}/cryptoKeys/${input.keyId}`;
    },
    async bindRole(input) {
      record('bindRole', `${input.resource}|${input.role}`);
      return `${input.resource}|${input.role}|${input.member}`;
    },
    async createService(input) {
      record('createService', input.name);
      return { name: `projects/xaa-test/locations/asia-northeast1/services/${input.name}`, uri: `https://${input.name}.test` };
    },
    async createJob(input) {
      record('createJob', input.name);
      return `projects/xaa-test/locations/asia-northeast1/jobs/${input.name}`;
    },
    async healthCheck() { return true; },
  };
}

export interface ProvisionerHarness {
  documents: DocumentStore;
  seedStore: DocumentStore;
  admin: GcpAdmin & { calls: AdminCall[] };
  jobRuns: Array<{ jobName: string; env: Array<{ name: string; value: string }> }>;
  activity: Array<Record<string, unknown>>;
  logs: string[];
  deps: ProvisionerAppDeps;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export async function createProvisionerHarness(options: {
  config?: Partial<ProvisionerConfig>;
  idpConnectionStatus?: 'READY' | 'CONSENT_REQUIRED';
  verifyStatus?: string;
  admin?: GcpAdmin & { calls: AdminCall[] };
  now?: () => number;
  idpPublicJwk?: JsonWebKey;
} = {}): Promise<ProvisionerHarness> {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'provisioner');
  const seedStore = createFirestoreDocumentStore(firestore, 'seed');
  for (const tool of seededTools()) await seedStore.set('catalog_tools', tool.tool_id, { ...tool });
  for (const connector of seededConnectors()) await seedStore.set('catalog_connectors', connector.connector_id, { ...connector });

  const admin = options.admin ?? recordingAdmin();
  const jobRuns: Array<{ jobName: string; env: Array<{ name: string; value: string }> }> = [];
  const activity: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const now = options.now ?? (() => Date.now());

  const { createDedicatedResources } = await import('../src/dedicated.js');
  const deps: ProvisionerAppDeps = {
    config: { ...testConfig, ...options.config },
    documents,
    transactions: createTransactionStore(documents, now),
    jobs: {
      async runJob(input) { jobRuns.push(input); return { executionName: `${input.jobName}/executions/exec-1` }; },
    },
    clock: { now },
    jtiStore: new InMemoryJtiStore(now),
    logger: createLogger('provisioner', 'provisioner', (line) => { logs.push(line); }),
    publishActivity: async (event) => { activity.push(event); },
    fetchImpl: (async () => Response.json({
      keys: [{ ...(options.idpPublicJwk ?? {}), kid: 'idp-testkey', alg: 'RS256', use: 'sig' }],
    })) as unknown as typeof fetch,
    agentOp: {
      async createIdpConnection() {
        return {
          status: options.idpConnectionStatus ?? 'READY',
          consentUrl: `${HUMAN_IDP_ISSUER}/authorize?client_id=agent-platform&scope=openid+offline_access`,
        };
      },
      async verifyIdpConnection() { return { status: options.verifyStatus ?? 'READY' }; },
    },
    createDedicated: (input): Promise<DedicatedResult> => createDedicatedResources({
      admin, ledger: input.ledger, agentId: input.agentId,
      projectId: 'xaa-test', region: 'asia-northeast1',
      signingKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idjag-signing',
      connectionKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idp-connection-encryption',
      imageEnv: { ISSUER: HUMAN_IDP_ISSUER },
      taskTimeoutSeconds: input.taskTimeoutSeconds,
      now, sleep: async () => undefined,
    }),
  };

  const app = createApp(deps);
  return {
    documents, seedStore, admin, jobRuns, activity, logs, deps,
    fetch: (path, init) => app.fetch(new Request(new URL(path, PROVISIONER_BASE), init)),
  };
}

export async function seedDecision(harness: ProvisionerHarness, options: {
  decisionId?: string;
  humanSubject?: string;
  capabilities: string[];
  isolationLevel?: IsolationLevel;
  constraints?: Record<string, Record<string, unknown>>;
  grantHumanPermissions?: boolean;
}): Promise<string> {
  const decisionId = options.decisionId ?? `dec_${crypto.randomUUID()}`;
  const humanSubject = options.humanSubject ?? 'testuser';
  await harness.seedStore.set('authorization_decisions', decisionId, {
    decision_id: decisionId,
    human_subject: humanSubject,
    effective_capabilities: options.capabilities,
    security_profile: { risk_score: 0, isolation_level: options.isolationLevel ?? 'standard', reasons: [] },
    constraints: options.constraints ?? {},
  });
  if (options.grantHumanPermissions !== false) {
    for (const capability of options.capabilities) {
      await harness.seedStore.set('human_permissions', `${humanSubject}__${capability}`, {
        human_subject: humanSubject, capability_id: capability, granted_at: new Date().toISOString(),
      });
    }
  }
  return decisionId;
}
