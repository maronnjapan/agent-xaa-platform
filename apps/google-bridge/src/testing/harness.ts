import { InMemoryJtiStore } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createStubOp from '@xaa/stub-saas-op/app';
import { createCallbackApp, createInternalApp, type BridgeDeps } from '../index.js';
import type { BridgeConfig } from '../config.js';
import { RESOURCE_SCOPES } from '@xaa/contracts';
import type { ConnectorDefinition } from '../connectors/types.js';

export const INTERNAL_BASE = 'https://google-bridge.test';
export const CALLBACK_BASE = 'https://google-bridge-callback.test';
export const AUTOMATION_BASE = 'https://automation-app.test';
export const STUB_OP_BASE = 'https://stub-saas-op.test';
export const SHARED_ISSUER = 'https://human-idp.test';

export const SA = {
  runtime: 'sa-agent-runtime@xaa-test.iam.gserviceaccount.com',
  provisioner: 'sa-provisioner@xaa-test.iam.gserviceaccount.com',
  lifecycle: 'sa-lifecycle@xaa-test.iam.gserviceaccount.com',
};

/** The scope name lives in the shared identifier table (00b), not in this fixture. */
export const CALENDAR_READ = RESOURCE_SCOPES.find((scope) => scope.startsWith('calendar.'))!;

export const STUB_CONNECTOR: ConnectorDefinition = {
  connector_id: 'stub-saas',
  display_name: 'Stub SaaS',
  authorization_endpoint: `${STUB_OP_BASE}/authorize`,
  token_endpoint: `${STUB_OP_BASE}/token`,
  revocation_endpoint: `${STUB_OP_BASE}/revoke`,
  userinfo_endpoint: `${STUB_OP_BASE}/userinfo`,
  client_id: 'stub-bridge-client',
  secret_name: 'projects/xaa-test/secrets/stub-bridge-secret',
  default_scopes: [CALENDAR_READ],
  subject_claim: 'sub',
  connection_max_age_seconds: 2_592_000,
  resource_uris: ['https://stub-saas-api.test'],
};

export const testConfig: BridgeConfig = {
  face: 'internal',
  sharedIssuer: SHARED_ISSUER,
  jwksUrl: 'https://storage.test/xaa-jwks/jwks.json',
  bridgeInternalBaseUrl: INTERNAL_BASE,
  bridgeCallbackBaseUrl: CALLBACK_BASE,
  automationAppBaseUrl: AUTOMATION_BASE,
  provisionerBaseUrl: 'https://provisioner.test',
  connectorEncryptionKey: 'projects/xaa-test/locations/l/keyRings/connector-encryption/cryptoKeys/shared',
  agentMaxLifetimeSeconds: 86_400,
  saasConnectorMode: 'stub',
  callerSaRuntime: SA.runtime,
  callerSaSlots: [],
  callerSaProvisioner: SA.provisioner,
  callerSaLifecycle: SA.lifecycle,
};

export interface BridgeHarness {
  internal(path: string, init?: RequestInit): Promise<Response>;
  callback(path: string, init?: RequestInit): Promise<Response>;
  documents: DocumentStore;
  seedStore: DocumentStore;
  logs: string[];
  outbound: string[];
  stubOp: ReturnType<typeof createStubOp>;
}

/**
 * Both faces in one process, with the stub SaaS wired in as the only reachable host.
 *
 * The Bridge's own allow list is what decides where a request may go; the transport here
 * simply routes an allowed host to the app standing in for it, so a test that reaches
 * somewhere unexpected fails inside the Bridge rather than silently succeeding.
 */
export function createBridgeHarness(options: {
  jwks?: { keys: Array<Record<string, unknown>> };
  caller?: string;
  now?: () => number;
  rotateRefreshToken?: 'always' | 'never';
  readTransaction?: BridgeDeps['readTransaction'];
  shared?: ReturnType<typeof createFirestoreDouble>;
  /** Share one stub across harnesses: it remembers the tokens it issued. */
  stubOp?: ReturnType<typeof createStubOp>;
} = {}): BridgeHarness {
  const firestore = options.shared ?? createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'google-bridge');
  // Connector definitions are seeded, never written by the Bridge, so the fixture
  // writes them with the seeder's scope.
  const seedStore = createFirestoreDocumentStore(firestore, 'seed');
  const logs: string[] = [];
  const outbound: string[] = [];
  const stubOp = options.stubOp ?? createStubOp({
    issuer: STUB_OP_BASE,
    ...(options.rotateRefreshToken ? { rotateRefreshToken: options.rotateRefreshToken } : {}),
  });

  const deps: BridgeDeps = {
    config: testConfig,
    documents,
    jtiStore: new InMemoryJtiStore(options.now),
    kms: {
      // A reversible stand-in for KMS: the point of the test is that the plaintext never
      // reaches Firestore, not that AES works.
      async encrypt(_keyName, plaintext) { return new Uint8Array([1, ...plaintext]); },
      async decrypt(_keyName, ciphertext) { return ciphertext.slice(1); },
    },
    readSecret: async () => 'stub-bridge-secret',
    send: async (url, init) => {
      outbound.push(url);
      const target = new URL(url);
      if (target.origin === STUB_OP_BASE) {
        return stubOp.fetch(new Request(url, init));
      }
      if (target.host === 'storage.test') {
        return Response.json(options.jwks ?? { keys: [] });
      }
      return new Response('{}', { status: 502 });
    },
    logger: createLogger('google-bridge', 'google_bridge', (line) => logs.push(line)),
    ...(options.now ? { now: options.now } : {}),
    callerVerify: async () => options.caller ?? SA.runtime,
    ...(options.readTransaction ? { readTransaction: options.readTransaction } : {}),
  };

  const internalApp = createInternalApp(deps);
  const callbackApp = createCallbackApp({ ...deps, config: { ...testConfig, face: 'callback' } });

  return {
    documents, seedStore, logs, outbound, stubOp,
    internal: async (path, init) => internalApp.fetch(new Request(new URL(path, INTERNAL_BASE), init)),
    callback: async (path, init) => callbackApp.fetch(new Request(new URL(path, CALLBACK_BASE), init)),
  };
}

export async function seedConnector(harness: BridgeHarness, overrides: Partial<ConnectorDefinition> = {}): Promise<void> {
  const definition = { ...STUB_CONNECTOR, ...overrides };
  await harness.seedStore.set('connector_definitions', definition.connector_id, definition as unknown as Record<string, unknown>);
}

/**
 * Walks a real consent: start, the stub's authorize, then the callback.
 *
 * Tests that need a usable connection get one the way production does — with a refresh
 * token the stub actually issued — rather than by writing a plausible-looking row. A
 * seeded token would make every refresh grant fail for a reason unrelated to the test.
 */
export async function completeConsent(harness: BridgeHarness, options: {
  transactionId?: string;
  humanSubject?: string;
  scopes?: string[];
} = {}): Promise<{ code: string; transactionId: string }> {
  const transactionId = options.transactionId ?? 'tx-1';
  const started = await harness.callback(
    `/${STUB_CONNECTOR.connector_id}/oauth/start?transaction_id=${transactionId}`,
    { redirect: 'manual' },
  );
  const authorizeUrl = started.headers.get('location');
  if (!authorizeUrl) throw new Error(`consent did not start: ${started.status}`);

  const authorized = await harness.stubOp.fetch(new Request(authorizeUrl, { redirect: 'manual' }));
  const back = authorized.headers.get('location');
  if (!back) throw new Error('stub did not issue a code');

  const callbackUrl = new URL(back);
  const finished = await harness.callback(`${callbackUrl.pathname}${callbackUrl.search}`, { redirect: 'manual' });
  const complete = new URL(finished.headers.get('location') ?? 'https://invalid.test');
  const code = complete.searchParams.get('code');
  if (!code) throw new Error(`consent failed: ${complete.searchParams.get('reason')}`);
  return { code, transactionId };
}

export function transactionReader(options: {
  humanSubject?: string;
  scopes?: string[];
  status?: string;
} = {}): NonNullable<BridgeDeps['readTransaction']> {
  return async () => ({
    status: options.status ?? 'WAITING_EXTERNAL_CONSENT',
    human_subject: options.humanSubject ?? 'testuser',
    required_scopes: options.scopes ?? [CALENDAR_READ],
  });
}
