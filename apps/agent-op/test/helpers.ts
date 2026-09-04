import { randomUUID, randomBytes } from 'node:crypto';
import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, InMemoryJtiStore,
  jwkThumbprint, signCompactJws, type Es256KeyPair, type Es256Signer,
} from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { CLIENT_ASSERTION_TYPE, JWT_TYP, ACTOR_TOKEN_TYP } from '@xaa/contracts';
import createApp, { type AgentOpAppDeps } from '../src/app.js';
import type { AgentOpConfig } from '../src/config.js';
import type { AgentRegistration } from '../src/store/types.js';
import type { JwkSet } from '../src/keys/shared-jwks.js';
import type { ActivityEvent } from '../src/log/protocol-violation-event.js';

export const ISSUER = 'https://human-idp.test';
export const AGENT_OP_BASE = 'https://shared-agent-op.test';
export const LIFECYCLE_SA = 'sa-lifecycle@xaa-test.iam.gserviceaccount.com';
export const PROVISIONER_SA = 'sa-provisioner@xaa-test.iam.gserviceaccount.com';
export const DOCS_AS_ISSUER = 'https://resource-docs-as.test';
export const DOCS_API_RESOURCE = 'https://resource-docs-api.test';
export const HUMAN_SUBJECT = 'user-1';

export function newAgentId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (const byte of randomBytes(26)) out += alphabet[byte % alphabet.length];
  return `agent-${out}`;
}

export function baseConfig(overrides: Partial<AgentOpConfig> = {}): AgentOpConfig {
  return {
    mode: 'token',
    issuer: ISSUER,
    xaaClientId: 'agent-platform',
    googleCloudProject: 'xaa-test',
    firestoreDatabase: 'xaa-db',
    jwksBucket: 'xaa-jwks',
    jwksObject: 'jwks.json',
    kmsIdjagKey: 'projects/p/locations/l/keyRings/idjag-signing/cryptoKeys/shared/cryptoKeyVersions/1',
    kmsIdpConnectionKey: 'projects/p/locations/l/keyRings/idp-connection/cryptoKeys/shared',
    humanIdpAuthorizeUrl: `${ISSUER}/authorize`,
    humanIdpTokenUrl: `${ISSUER}/token`,
    humanIdpRevokeUrl: `${ISSUER}/revoke`,
    agentOpCallbackUrl: 'https://agent-op-callback.test',
    clientSecretAgentPlatform: 'test-agent-platform-secret',
    idJagLifetimeSeconds: 300,
    agentId: null,
    signerMode: 'local',
    storeMode: 'emulator',
    publicBaseUrl: AGENT_OP_BASE,
    ...overrides,
  };
}

/** Reversible in-process stand-in for KMS envelope encryption, AAD included. */
export const fakeEnvelope = {
  async encrypt(plaintext: string, aad: string) { return Buffer.from(`${aad}::${plaintext}`, 'utf8').toString('base64'); },
  async decrypt(ciphertext: string, aad: string) {
    const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
    const separator = decoded.indexOf('::');
    if (decoded.slice(0, separator) !== aad) throw new Error('AAD mismatch');
    return decoded.slice(separator + 2);
  },
};

export const FIXTURE_BASE = Date.now();

export interface Fixture {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  documents: DocumentStore;
  agentId: string;
  agentKeyPair: Es256KeyPair;
  dpopKeyPair: Es256KeyPair;
  idpSigner: Es256Signer;
  idpKeyPair: Es256KeyPair;
  opSigner: Es256Signer;
  events: ActivityEvent[];
  exchangeLogs: string[];
  ledgerLogs: string[];
  connectionLogs: string[];
  registration: AgentRegistration;
  now(): number;
  setNow(value: number): void;
  humanIdpResponses: Response[];
  /** What the route actually sent to Human IdP, headers lower-cased. */
  humanIdpRequests: Array<{ url: string; headers: Record<string, string>; body: string }>;
}

export async function createFixture(options: {
  config?: Partial<AgentOpConfig>;
  registration?: Partial<AgentRegistration>;
  xaaConfig?: Partial<{ allowed_audiences: string[]; resources: string[]; scopes: string[]; trusted_resource_as: string[] }>;
  /** Replaces the ledger writer, so a test can make the issuance ledger unwritable. */
  writeLedger?: (line: string) => void;
} = {}): Promise<Fixture> {
  const agentId = options.registration?.agent_id ?? newAgentId();
  const agentKeyPair = await generateEs256KeyPair();
  const dpopKeyPair = await generateEs256KeyPair();
  const idpKeyPair = await generateEs256KeyPair();
  const opKeyPair = await generateEs256KeyPair();
  const idpSigner = createLocalEs256Signer({ privateKey: idpKeyPair.privateKey, kid: 'idp-testkey' });
  const opSigner = createLocalEs256Signer({ privateKey: opKeyPair.privateKey, kid: 'op-shared-1' });

  // The library's subject-token verification reads the real clock, so the injected
  // one starts from now rather than a fixed date; tests move it with setNow.
  let clock = Date.now();
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'agent-op');
  // Registrations are written by the Provisioner, never by Agent OP, so the fixture
  // seeds them through a provisioner-scoped store.
  const seed = createFirestoreDocumentStore(firestore, 'provisioner');

  const registration: AgentRegistration = {
    agent_id: agentId,
    human_subject: HUMAN_SUBJECT,
    client_auth: { method: 'client_assertion_jwt', jwk_thumbprint: await jwkThumbprint(agentKeyPair.publicJwk), public_jwk: agentKeyPair.publicJwk as JsonWebKey },
    idp_connection_id: `idpconn-${agentId}`,
    isolation_level: 'standard',
    dedicated_op: null,
    status: 'ACTIVE',
    created_at: new Date(clock).toISOString(),
    expires_at: new Date(clock + 86_400_000).toISOString(),
    ...options.registration,
  };
  await seed.set('agents', `${registration.agent_id}__meta`, {
    ...registration,
    allowed_audiences: [DOCS_AS_ISSUER],
    resources: [DOCS_API_RESOURCE],
    scopes: ['docs.read', 'docs.write'],
    trusted_resource_as: [DOCS_AS_ISSUER],
    ...options.xaaConfig,
  });

  const events: ActivityEvent[] = [];
  const exchangeLogs: string[] = [];
  const ledgerLogs: string[] = [];
  const connectionLogs: string[] = [];
  const humanIdpResponses: Response[] = [];
  const humanIdpRequests: Fixture['humanIdpRequests'] = [];

  const deps: AgentOpAppDeps = {
    config: baseConfig(options.config),
    documents,
    jtiStore: new InMemoryJtiStore(() => clock),
    signer: opSigner,
    // `alg` is part of every published JWK (publishPublicKey writes it), and core's
    // id_token_hint verification skips candidates whose alg does not match the header.
    jwksSource: { async read(): Promise<JwkSet> { return { keys: [{ ...idpKeyPair.publicJwk, kid: 'idp-testkey', alg: 'ES256', use: 'sig' }, { ...opKeyPair.publicJwk, kid: 'op-shared-1', alg: 'ES256', use: 'sig' }] }; } },
    envelope: fakeEnvelope,
    publisher: { async publish(_topic, event) { events.push(event); } },
    revision: 'agent-op-00001-abc',
    now: () => clock,
    writeExchangeLog: (line) => { exchangeLogs.push(line); },
    writeLedger: options.writeLedger ?? ((line) => { ledgerLogs.push(line); }),
    writeConnectionLog: (line) => { connectionLogs.push(line); },
    humanIdpFetch: (async (url: string, init: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
      humanIdpRequests.push({ url: String(url), headers, body: String(init?.body ?? '') });
      return humanIdpResponses.shift() ?? new Response('{}', { status: 400 });
    }) as unknown as typeof fetch,
    automationAppUrl: 'https://automation-app.test',
    // Stands in for the Cloud Run ID Token check: the bearer value is the caller's
    // service account email, so a test can present the wrong identity as easily as
    // the right one.
    serviceIdentity: { async verify(authorization) { return authorization?.match(/^Bearer (.+)$/)?.[1] ?? null; } },
    lifecycleServiceAccount: LIFECYCLE_SA,
    provisionerServiceAccount: PROVISIONER_SA,
  };

  const app = createApp(deps);
  return {
    fetch: (path, init) => app.fetch(new Request(new URL(path, AGENT_OP_BASE), init)),
    documents, agentId: registration.agent_id, agentKeyPair, dpopKeyPair, idpSigner, idpKeyPair, opSigner,
    events, exchangeLogs, ledgerLogs, connectionLogs, registration,
    now: () => clock,
    setNow: (value) => { clock = value; },
    humanIdpResponses,
    humanIdpRequests,
  };
}

export async function clientAssertion(fixture: Fixture, options: { path?: string; agentId?: string; keyPair?: Es256KeyPair; typ?: string; header?: Record<string, unknown>; jti?: string; lifetime?: number } = {}): Promise<string> {
  const agentId = options.agentId ?? fixture.agentId;
  const keyPair = options.keyPair ?? fixture.agentKeyPair;
  const iat = Math.floor(fixture.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: options.typ ?? JWT_TYP.CLIENT_ASSERTION, ...options.header } as never,
    payload: {
      iss: agentId, sub: agentId, aud: `${AGENT_OP_BASE}${options.path ?? '/xaa/token'}`,
      iat, exp: iat + (options.lifetime ?? 120), jti: options.jti ?? randomUUID(),
    },
    signer: createLocalEs256Signer({ privateKey: keyPair.privateKey, kid: agentId }),
  });
}

export async function actorToken(fixture: Fixture, options: { agentId?: string; keyPair?: Es256KeyPair; typ?: string; header?: Record<string, unknown>; jti?: string; lifetime?: number; iat?: number } = {}): Promise<string> {
  const agentId = options.agentId ?? fixture.agentId;
  const keyPair = options.keyPair ?? fixture.agentKeyPair;
  const iat = options.iat ?? Math.floor(fixture.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: options.typ ?? ACTOR_TOKEN_TYP, ...options.header } as never,
    payload: { iss: agentId, sub: agentId, aud: ISSUER, iat, exp: iat + (options.lifetime ?? 120), jti: options.jti ?? randomUUID() },
    signer: createLocalEs256Signer({ privateKey: keyPair.privateKey, kid: agentId }),
  });
}

export async function subjectToken(fixture: Fixture, overrides: Record<string, unknown> = {}, signer?: Es256Signer): Promise<string> {
  const iat = Math.floor(fixture.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: JWT_TYP.ID_TOKEN, kid: signer ? signer.kid : 'idp-testkey' },
    payload: { iss: ISSUER, sub: HUMAN_SUBJECT, aud: 'agent-platform', iat, exp: iat + 3600, ...overrides },
    signer: signer ?? fixture.idpSigner,
  });
}

export interface ExchangeOptions {
  path?: string;
  form?: Record<string, string>;
  assertion?: string;
  proof?: string;
  omitProof?: boolean;
}

export async function exchange(fixture: Fixture, options: ExchangeOptions = {}): Promise<Response> {
  const path = options.path ?? '/xaa/token';
  const form: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: await subjectToken(fixture),
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    actor_token: await actorToken(fixture),
    actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    audience: DOCS_AS_ISSUER,
    resource: DOCS_API_RESOURCE,
    scope: 'docs.read',
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: options.assertion ?? await clientAssertion(fixture, { path }),
    ...options.form,
  };
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (!options.omitProof) {
    headers.DPoP = options.proof ?? await createDpopProof({
      method: 'POST', url: `${AGENT_OP_BASE}${path}`, keyPair: fixture.dpopKeyPair, now: fixture.now,
    });
  }
  return fixture.fetch(path, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
}

export function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function decodeHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}
