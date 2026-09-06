/**
 * The Provisioner wired for tests, with GCP replaced by recorders.
 *
 * It lives in `src` rather than `test` because the end-to-end suite needs the same
 * wiring — the alternative is a second copy of it that drifts from this one.
 */
import { InMemoryJtiStore } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { PLATFORM_CLIENT_ID, RESOURCE_SCOPES } from '@xaa/contracts';
import type { ActivityEvent, CatalogConnector, CatalogTool, IsolationLevel } from '@xaa/contracts';
import createApp, { type ProvisionerAppDeps } from '../app.js';
import { createTransactionStore } from '../transaction/store.js';
import type { DedicatedResult, GcpAdmin } from '../dedicated.js';
import type { ProvisionerConfig } from '../deps.js';

export const PROVISIONER_BASE = 'https://provisioner.test';
export const HUMAN_IDP_ISSUER = 'https://human-idp.test';

/**
 * Walks up to the repository's `infra/seed` so the same file works from `src` and from
 * `dist`, whose depths differ.
 */
function findSeedRoot(): string {
  let directory = new URL('.', import.meta.url).pathname;
  for (let step = 0; step < 8; step += 1) {
    try { readdirSync(`${directory}infra/seed/tools`); return `${directory}infra/seed/`; }
    catch { directory = new URL('..', `file://${directory}`).pathname; }
  }
  throw new Error('infra/seed not found');
}

const seedRoot = findSeedRoot();

/** The seeded catalogue, with the Terraform placeholders resolved to test URLs. */
function resolvePlaceholders(text: string): string {
  return text
    .replaceAll('${issuer:docs}', 'https://resource-docs-as.test')
    .replaceAll('${resource:docs}', 'https://resource-docs-api.test')
    .replaceAll('${issuer:finance}', 'https://resource-finance-as.test')
    .replaceAll('${resource:finance}', 'https://resource-finance-api.test')
    .replaceAll('${issuer:stub_saas}', 'https://stub-saas-op.test')
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
  internalCallers: ['sa-lifecycle@xaa-test.iam.gserviceaccount.com'],
  adminPrincipals: ['admin@example.test'],
};

export const LIFECYCLE_CALLER = 'sa-lifecycle@xaa-test.iam.gserviceaccount.com';

/** The one account `ADMIN_PRINCIPALS` names in these specs. */
export const ADMIN_PRINCIPAL = 'admin@example.test';

export interface AdminCall { method: string; name: string }

export interface BridgeCall { method: string; connectorId: string; scopes: string[] }

export const BRIDGE_CONSENT_URL = 'https://google-bridge-callback.test/stub-saas-calendar/oauth/start';

/** The scope the one bridged tool asks for, from the shared table rather than spelled out. */
const BRIDGED_SCOPE = RESOURCE_SCOPES.find((scope) => scope.startsWith('calendar.'))!;

/**
 * The Bridge as the Provisioner sees it: three calls and a recorder.
 *
 * `connectionStatus` is what `/connections/check` answers, which is the one branch the
 * bridged steps turn on — a person who has never connected this SaaS gets a consent
 * screen, and a second agent for the same person gets `READY` and no browser at all.
 */
export function recordingBridge(options: {
  connectionStatus?: 'READY' | 'CONSENT_REQUIRED';
  verifyStatus?: string;
  failAt?: 'checkConnection' | 'verifyConnection' | 'createBinding';
} = {}): NonNullable<ProvisionerAppDeps['bridge']> & { calls: BridgeCall[] } {
  const calls: BridgeCall[] = [];
  const record = (method: BridgeCall['method'], connectorId: string, scopes: string[]): void => {
    calls.push({ method, connectorId, scopes });
    if (options.failAt === method) throw new Error(`${method} failed`);
  };
  return {
    calls,
    async checkConnection(input) {
      record('checkConnection', input.connectorId, input.requiredScopes);
      if ((options.connectionStatus ?? 'READY') === 'READY') {
        return { status: 'READY', connection_id: `conn-${input.connectorId}-${input.humanSubject}` };
      }
      return {
        status: 'CONSENT_REQUIRED',
        consent_url: `${BRIDGE_CONSENT_URL}?transaction_id=${encodeURIComponent(input.transactionId)}`,
        missing_scopes: [...input.requiredScopes],
      };
    },
    async verifyConnection(input) {
      record('verifyConnection', '', []);
      return {
        status: options.verifyStatus ?? 'READY',
        connection_id: `conn-verified-${input.transactionId}`,
        granted_scopes: [BRIDGED_SCOPE],
      };
    },
    async createBinding(input) {
      record('createBinding', input.connectorId, input.scopes);
      return { binding_id: `bind-${input.agentId}`, expires_at: input.expiresAt };
    },
  };
}

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
      const email = `${input.accountId}@xaa-test.iam.gserviceaccount.com`;
      return { name: `projects/xaa-test/serviceAccounts/${email}`, email, member: `serviceAccount:${email}` };
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
  bridge?: NonNullable<ProvisionerAppDeps['bridge']> & { calls: BridgeCall[] };
  jobRuns: Array<{ jobName: string; env: Array<{ name: string; value: string }> }>;
  activity: ActivityEvent[];
  logs: string[];
  revokedConnections: string[];
  deps: ProvisionerAppDeps;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The same request, carrying a token for whoever is named (the admin by default). */
  asAdmin(path: string, init?: RequestInit & { principal?: string }): Promise<Response>;
}

export async function createProvisionerHarness(options: {
  /** One Firestore across several apps, for a test that spans them. */
  shared?: ReturnType<typeof createFirestoreDouble>;
  config?: Partial<ProvisionerConfig>;
  idpConnectionStatus?: 'READY' | 'CONSENT_REQUIRED';
  verifyStatus?: string;
  admin?: GcpAdmin & { calls: AdminCall[] };
  /**
   * The Bridge client, absent by default. A deployment without the Bridge has none
   * (DEC-SCOPE-04), and that is the default here so a test has to say when it means
   * the bridged path.
   */
  bridge?: NonNullable<ProvisionerAppDeps['bridge']> & { calls: BridgeCall[] };
  now?: () => number;
  idpPublicJwk?: JsonWebKey;
  /** Resolves an `/internal/*` bearer token to a caller email; defaults to sa-lifecycle. */
  verifyInternalCaller?: (token: string, audience: string) => Promise<string | null>;
  /**
   * Overrides the default recording stub, which never leaves this process. Pass the
   * real `publishActivityEvent` from `@xaa/contracts` for a test that needs the events
   * to travel the same in-process queue production's Pub/Sub subscriber drains.
   */
  publishActivity?: (event: ActivityEvent) => Promise<void>;
} = {}): Promise<ProvisionerHarness> {
  const firestore = options.shared ?? createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'provisioner');
  const seedStore = createFirestoreDocumentStore(firestore, 'seed');
  for (const tool of seededTools()) await seedStore.set('catalog_tools', tool.tool_id, { ...tool });
  for (const connector of seededConnectors()) await seedStore.set('catalog_connectors', connector.connector_id, { ...connector });

  const admin = options.admin ?? recordingAdmin();
  const jobRuns: Array<{ jobName: string; env: Array<{ name: string; value: string }> }> = [];
  const activity: ActivityEvent[] = [];
  const logs: string[] = [];
  const revokedConnections: string[] = [];
  const now = options.now ?? (() => Date.now());

  const { createDedicatedResources } = await import('../dedicated.js');
  const agentOp: ProvisionerAppDeps['agentOp'] = {
    async createIdpConnection() {
      return {
        status: options.idpConnectionStatus ?? 'READY',
        // The one registered client, from the constant that owns it (RULE-50): a
        // literal here would be a second place the id is written down.
        consentUrl: `${HUMAN_IDP_ISSUER}/authorize?client_id=${PLATFORM_CLIENT_ID}&scope=openid+offline_access`,
      };
    },
    async verifyIdpConnection() { return { status: options.verifyStatus ?? 'READY' }; },
    async revokeIdpConnection(idpConnectionId) { revokedConnections.push(idpConnectionId); },
  };

  const deps: ProvisionerAppDeps = {
    config: { ...testConfig, ...options.config },
    documents,
    transactions: createTransactionStore(documents, now, {
      revokeIdpConnection: (idpConnectionId) => agentOp.revokeIdpConnection!(idpConnectionId),
    }),
    jobs: {
      async runJob(input) { jobRuns.push(input); return { executionName: `${input.jobName}/executions/exec-1` }; },
    },
    clock: { now },
    jtiStore: new InMemoryJtiStore(now),
    logger: createLogger('provisioner', 'provisioner', (line) => { logs.push(line); }),
    publishActivity: options.publishActivity ?? (async (event) => { activity.push(event); }),
    // The token itself is never checked in tests: what matters is that a caller who is
    // not on the allow-list is refused, and that is the email, not the signature.
    verifyInternalCaller: options.verifyInternalCaller
      ?? (async (token) => (token === 'lifecycle-token' ? LIFECYCLE_CALLER : null)),
    /**
     * Stands in for Google's OIDC verification on the console: the token is the account
     * it was minted for, and a token minted for another service's URL resolves to
     * nobody, so the audience check the real verifier makes is still exercised.
     */
    verifyAdmin: async (token, audience) => (audience === PROVISIONER_BASE ? token : null),
    fetchImpl: (async () => Response.json({
      keys: [{ ...(options.idpPublicJwk ?? {}), kid: 'idp-testkey', alg: 'RS256', use: 'sig' }],
    })) as unknown as typeof fetch,
    agentOp,
    ...(options.bridge ? { bridge: options.bridge } : {}),
    createDedicated: (input): Promise<DedicatedResult> => createDedicatedResources({
      admin, ledger: input.ledger, agentId: input.agentId,
      projectId: 'xaa-test', region: 'asia-northeast1',
      signingKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idjag-signing',
      connectionKeyRing: 'projects/xaa-test/locations/asia-northeast1/keyRings/idp-connection-encryption',
      imageEnv: { ISSUER: HUMAN_IDP_ISSUER },
      runtimeEnv: { PROJECT_ID: 'xaa-test' },
      jwksBucket: 'xaa-test-jwks',
      activityTopic: 'agent-activity-stream',
      runtimeInvokerServices: [
        'projects/xaa-test/locations/asia-northeast1/services/resource-docs-as',
        'projects/xaa-test/locations/asia-northeast1/services/resource-finance-as',
      ],
      provisionerMember: 'serviceAccount:sa-provisioner@xaa-test.iam.gserviceaccount.com',
      agentPlatformClientSecret: `projects/xaa-test/secrets/human-idp-${PLATFORM_CLIENT_ID}-client-secret`,
      taskTimeoutSeconds: input.taskTimeoutSeconds,
      now, sleep: async () => undefined,
    }),
  };

  const app = createApp(deps);
  return {
    documents, seedStore, admin, jobRuns, activity, logs, revokedConnections, deps,
    bridge: options.bridge,
    fetch: async (path, init) => app.fetch(new Request(new URL(path, PROVISIONER_BASE), init)),
    asAdmin: async (path, init = {}) => {
      const { principal = ADMIN_PRINCIPAL, ...request } = init;
      return app.fetch(new Request(new URL(path, PROVISIONER_BASE), {
        ...request,
        headers: { ...(request.headers as Record<string, string> | undefined), Authorization: `Bearer ${principal}` },
      }));
    },
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
