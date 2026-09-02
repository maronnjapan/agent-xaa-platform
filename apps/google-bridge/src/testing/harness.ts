import type { Hono } from 'hono';
import {
  InMemoryJtiStore, createDpopProof, createLocalEs256Signer, generateEs256KeyPair, jwkThumbprint,
  signCompactJws, type Es256KeyPair,
} from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createStubOp from '@xaa/stub-saas-op/app';
import { createCallbackApp, createInternalApp, type BridgeDeps } from '../index.js';
import type { BridgeConfig } from '../config.js';
import {
  JWT_BEARER_GRANT_TYPE, JWT_TYP, PLATFORM_CLIENT_ID, RESOURCE_SCOPES, toAgentUrn,
} from '@xaa/contracts';
import type { ConnectorDefinition } from '../connectors/types.js';
import { connectionId } from '../store/connection.js';

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
export const GMAIL_SEND = RESOURCE_SCOPES.find((scope) => scope.startsWith('gmail.') && scope.endsWith('.send'))!;

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
  /**
   * The two apps themselves, so a test can read the route table rather than probe it
   * one path at a time. Which routes exist is the part of the split that has to stay
   * fixed (T-BRIDGE-01), and a snapshot of `app.routes` is the only way to notice a
   * route someone added to the browser-facing face by accident.
   */
  routes: { internal: string[]; callback: string[] };
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
  /** Answer the SaaS token endpoint with this status instead of running the stub. */
  saasTokenStatus?: number;
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
        // A SaaS that is having a bad day rather than one that has revoked anything:
        // the difference decides whether the connection is written off or left alone.
        if (options.saasTokenStatus !== undefined && target.pathname === '/token') {
          return new Response('{}', { status: options.saasTokenStatus });
        }
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
    routes: { internal: routeList(internalApp), callback: routeList(callbackApp) },
    internal: async (path, init) => internalApp.fetch(new Request(new URL(path, INTERNAL_BASE), init)),
    callback: async (path, init) => callbackApp.fetch(new Request(new URL(path, CALLBACK_BASE), init)),
  };
}

/**
 * `method path`, sorted and deduplicated.
 *
 * Hono lists a route once per handler, so a route with a caller-authz middleware in
 * front of it appears twice. What has to be fixed is the set of reachable paths, not
 * how many functions each one runs through.
 */
function routeList(app: Hono): string[] {
  return [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))].sort();
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

export const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
export const RESOURCE = STUB_CONNECTOR.resource_uris[0]!;

/**
 * A connection row that looks exactly like one the callback face wrote.
 *
 * Tests about refusal — an expired binding, a revoked connection, a caller with the
 * wrong service account — never reach the SaaS, so they do not need a refresh token the
 * stub would honour. Tests that do reach it use `completeConsent` instead.
 */
export async function seedConnection(harness: BridgeHarness, options: {
  grantedScopes?: string[];
  status?: string;
  expiresAt?: string;
  humanSubject?: string;
} = {}): Promise<string> {
  const humanSubject = options.humanSubject ?? 'testuser';
  const id = connectionId(STUB_CONNECTOR.connector_id, humanSubject);
  await harness.documents.set('bridge_connections', id, {
    connection_id: id, connector_id: STUB_CONNECTOR.connector_id, human_subject: humanSubject,
    external_subject: 'stub-user-001',
    encrypted_refresh_token: new Uint8Array([1, ...new TextEncoder().encode('stub-refresh')]),
    granted_scopes: options.grantedScopes ?? [CALENDAR_READ, GMAIL_SEND],
    status: options.status ?? 'ACTIVE',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: options.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
  });
  return id;
}

export async function seedBinding(harness: BridgeHarness, options: {
  agentId?: string;
  scopes?: string[];
  status?: string;
  expiresAt?: string;
  humanSubject?: string;
} = {}): Promise<string> {
  const agentId = options.agentId ?? AGENT_ID;
  const id = `${agentId}:${STUB_CONNECTOR.connector_id}`;
  await harness.documents.set('agent_bindings', id, {
    binding_id: id, agent_id: agentId, connector_id: STUB_CONNECTOR.connector_id,
    connection_id: connectionId(STUB_CONNECTOR.connector_id, options.humanSubject ?? 'testuser'),
    human_subject: options.humanSubject ?? 'testuser',
    scopes: options.scopes ?? [CALENDAR_READ],
    status: options.status ?? 'ACTIVE',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  });
  return id;
}

/**
 * `POST /token` exactly as the Agent Runtime sends it: form-encoded, an invoker token
 * for the service, and a DPoP proof over the same key the ID-JAG names.
 */
export async function exchangeToken(harness: BridgeHarness, options: {
  idJag: string;
  dpopKey?: Es256KeyPair;
  omitProof?: boolean;
  proof?: string;
  scope?: string;
  grantType?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Bearer caller-token',
  };
  if (!options.omitProof) {
    headers.DPoP = options.proof ?? await createDpopProof({
      method: 'POST', url: `${INTERNAL_BASE}/token`,
      keyPair: options.dpopKey ?? await generateEs256KeyPair(),
    });
  }
  return harness.internal('/token', {
    method: 'POST', headers,
    body: new URLSearchParams({
      grant_type: options.grantType ?? JWT_BEARER_GRANT_TYPE,
      assertion: options.idJag,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    }).toString(),
  });
}

/**
 * A Bridge with a connection the stub SaaS will actually honour.
 *
 * The consent runs for real, so the refresh grant that follows exercises the Bridge
 * rather than a fabricated row: a hand-written refresh token would make every grant
 * fail for a reason unrelated to whatever the test is about.
 */
export async function readyBridge(options: {
  rotateRefreshToken?: 'always' | 'never';
  bindingScopes?: string[];
  /** Applied after consent, so the connection exists before the SaaS starts failing. */
  saasTokenStatus?: number;
} = {}): Promise<{ harness: BridgeHarness; issuer: IdJagIssuer; dpopKey: Es256KeyPair }> {
  const issuer = await createIdJagIssuer();
  const dpopKey = await generateEs256KeyPair();
  const shared = createFirestoreDouble();
  const harness = createBridgeHarness({
    shared, jwks: issuer.jwks, readTransaction: transactionReader(),
    ...(options.rotateRefreshToken ? { rotateRefreshToken: options.rotateRefreshToken } : {}),
  });
  await seedConnector(harness);
  await completeConsent(harness);
  await seedBinding(harness, options.bindingScopes ? { scopes: options.bindingScopes } : {});
  if (options.saasTokenStatus === undefined) return { harness, issuer, dpopKey };

  // The same store and the same stub, with a token endpoint that now fails.
  const failing = createBridgeHarness({
    shared, jwks: issuer.jwks, readTransaction: transactionReader(),
    stubOp: harness.stubOp, saasTokenStatus: options.saasTokenStatus,
  });
  return { harness: failing, issuer, dpopKey };
}

export interface IdJagIssuer {
  jwks: { keys: Array<Record<string, unknown>> };
  mint(options?: {
    dpopKey?: Es256KeyPair;
    scope?: string;
    resource?: string;
    audience?: string;
    subject?: string;
    actSub?: string;
    typ?: string;
    omitCnf?: boolean;
    issuer?: string;
    agentId?: string;
  }): Promise<string>;
}

/**
 * The Agent OP's half of the exchange, reduced to what the Bridge verifies.
 *
 * The assertion is signed for real with a key the Bridge only ever sees through the
 * published key set, so a test that changes one claim changes the same bytes an agent
 * would send. Nothing here stands in for the verification itself.
 */
export async function createIdJagIssuer(): Promise<IdJagIssuer> {
  const key = await generateEs256KeyPair();
  const kid = 'op-shared-1';
  return {
    jwks: { keys: [{ ...key.publicJwk, kid, alg: 'ES256', use: 'sig' }] },
    async mint(options = {}) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: options.issuer ?? SHARED_ISSUER,
        sub: options.subject ?? 'testuser',
        aud: options.audience ?? INTERNAL_BASE,
        client_id: PLATFORM_CLIENT_ID,
        jti: `idjag-${Math.random().toString(36).slice(2)}`,
        iat: issuedAt,
        exp: issuedAt + 300,
        scope: options.scope ?? CALENDAR_READ,
        resource: options.resource ?? RESOURCE,
        act: { sub: options.actSub ?? toAgentUrn(options.agentId ?? AGENT_ID) },
      };
      if (!options.omitCnf) {
        payload.cnf = { jkt: await jwkThumbprint((options.dpopKey ?? await generateEs256KeyPair()).publicJwk) };
      }
      return signCompactJws({
        header: { alg: 'ES256', typ: options.typ ?? JWT_TYP.ID_JAG, kid },
        payload,
        signer: createLocalEs256Signer({ privateKey: key.privateKey, kid }),
      });
    },
  };
}
