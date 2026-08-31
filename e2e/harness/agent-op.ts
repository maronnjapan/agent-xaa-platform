import { randomBytes, randomUUID } from 'node:crypto';
import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, InMemoryJtiStore,
  jwkThumbprint, signCompactJws, type Es256KeyPair,
} from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { ACTOR_TOKEN_TYP, CLIENT_ASSERTION_TYPE, JWT_TYP } from '@xaa/contracts';
import createAgentOp, { type AgentOpAppDeps } from '@xaa/agent-op/app';
import type { AgentOpConfig } from '@xaa/agent-op/src/config';
import type { ActivityEvent } from '@xaa/agent-op/src/log/protocol-violation-event';
import type { Fetcher } from './oauth-flow.js';
import { HUMAN_IDP_ISSUER } from './human-idp.js';

export const AGENT_OP_BASE = 'https://shared-agent-op.test';
export const DOCS_AS_ISSUER = 'https://resource-docs-as.test';
export const DOCS_API_RESOURCE = 'https://resource-docs-api.test';
export const FINANCE_AS_ISSUER = 'https://resource-finance-as.test';
export const FINANCE_API_RESOURCE = 'https://resource-finance-api.test';

export function newAgentId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (const byte of randomBytes(26)) out += alphabet[byte % alphabet.length];
  return `agent-${out}`;
}

export interface AgentOpHarness {
  fetch: Fetcher;
  documents: DocumentStore;
  /** Lifecycle-scoped view of the same data, for tests that model a status change. */
  lifecycleStore: DocumentStore;
  agentId: string;
  agentKeyPair: Es256KeyPair;
  dpopKeyPair: Es256KeyPair;
  events: ActivityEvent[];
  exchangeLogs: string[];
  ledgerLogs: string[];
  opPublicJwk: JsonWebKey;
  now(): number;
}

export interface StartAgentOpOptions {
  /** Human IdP's SSO public JWK, so subject tokens verify against the shared set. */
  idpPublicJwk: JsonWebKey;
  humanIdpFetch?: typeof fetch;
  humanSubject?: string;
  agentId?: string;
  isolationLevel?: 'standard' | 'full_isolation';
  allowedAudiences?: string[];
  resources?: string[];
  scopes?: string[];
  config?: Partial<AgentOpConfig>;
  expiresAt?: string;
}

export async function startAgentOp(options: StartAgentOpOptions): Promise<AgentOpHarness> {
  const agentId = options.agentId ?? newAgentId();
  const agentKeyPair = await generateEs256KeyPair();
  const dpopKeyPair = await generateEs256KeyPair();
  const opKeyPair = await generateEs256KeyPair();
  const opSigner = createLocalEs256Signer({ privateKey: opKeyPair.privateKey, kid: 'op-shared-1' });
  const now = () => Date.now();

  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'agent-op');
  const seed = createFirestoreDocumentStore(firestore, 'provisioner');
  const lifecycleStore = createFirestoreDocumentStore(firestore, 'lifecycle-manager');
  const expiresAt = options.expiresAt ?? new Date(now() + 86_400_000).toISOString();

  await seed.set('agents', `${agentId}__meta`, {
    agent_id: agentId,
    human_subject: options.humanSubject ?? 'testuser',
    client_auth: { method: 'client_assertion_jwt', jwk_thumbprint: await jwkThumbprint(agentKeyPair.publicJwk), public_jwk: agentKeyPair.publicJwk },
    idp_connection_id: `idpconn-${agentId}`,
    isolation_level: options.isolationLevel ?? 'standard',
    dedicated_op: null,
    status: 'ACTIVE',
    created_at: new Date(now()).toISOString(),
    expires_at: expiresAt,
    allowed_audiences: options.allowedAudiences ?? [DOCS_AS_ISSUER],
    resources: options.resources ?? [DOCS_API_RESOURCE],
    scopes: options.scopes ?? ['docs.read', 'docs.write'],
    trusted_resource_as: options.allowedAudiences ?? [DOCS_AS_ISSUER],
  });

  const events: ActivityEvent[] = [];
  const exchangeLogs: string[] = [];
  const ledgerLogs: string[] = [];

  const deps: AgentOpAppDeps = {
    config: {
      mode: 'token', issuer: HUMAN_IDP_ISSUER, xaaClientId: 'agent-platform',
      googleCloudProject: 'xaa-test', firestoreDatabase: 'xaa', jwksBucket: 'xaa-jwks', jwksObject: 'jwks.json',
      kmsIdjagKey: 'projects/p/locations/l/keyRings/idjag-signing/cryptoKeys/shared/cryptoKeyVersions/1',
      kmsIdpConnectionKey: 'projects/p/locations/l/keyRings/idp-connection/cryptoKeys/shared',
      humanIdpAuthorizeUrl: `${HUMAN_IDP_ISSUER}/authorize`,
      humanIdpTokenUrl: `${HUMAN_IDP_ISSUER}/token`,
      humanIdpRevokeUrl: `${HUMAN_IDP_ISSUER}/revoke`,
      idJagLifetimeSeconds: 300, agentId: null, signerMode: 'local', storeMode: 'emulator',
      publicBaseUrl: AGENT_OP_BASE,
      ...options.config,
    },
    documents,
    jtiStore: new InMemoryJtiStore(now),
    signer: opSigner,
    jwksSource: {
      async read() {
        return { keys: [
          { ...options.idpPublicJwk, kid: 'idp-testkey', alg: 'RS256', use: 'sig' } as JsonWebKey & { kid: string },
          { ...opKeyPair.publicJwk, kid: 'op-shared-1', alg: 'ES256', use: 'sig' } as JsonWebKey & { kid: string },
        ] };
      },
    },
    envelope: {
      async encrypt(plaintext, aad) { return Buffer.from(`${aad}::${plaintext}`, 'utf8').toString('base64'); },
      async decrypt(ciphertext, aad) {
        const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
        if (!decoded.startsWith(`${aad}::`)) throw new Error('AAD mismatch');
        return decoded.slice(aad.length + 2);
      },
    },
    publisher: { async publish(_topic, event) { events.push(event); } },
    revision: 'agent-op-e2e',
    now,
    writeExchangeLog: (line) => { exchangeLogs.push(line); },
    writeLedger: (line) => { ledgerLogs.push(line); },
    ...(options.humanIdpFetch ? { humanIdpFetch: options.humanIdpFetch } : {}),
  };

  const app = createAgentOp(deps);
  return {
    fetch: async (path, init) => app.fetch(new Request(new URL(path, AGENT_OP_BASE), init)),
    documents, lifecycleStore, agentId, agentKeyPair, dpopKeyPair, events, exchangeLogs, ledgerLogs,
    opPublicJwk: { ...opKeyPair.publicJwk, kid: 'op-shared-1', alg: 'ES256', use: 'sig' } as JsonWebKey,
    now,
  };
}

export interface ExchangeInput {
  subjectToken: string;
  audience?: string;
  resource?: string;
  scope?: string;
  actorJti?: string;
  dpopKeyPair?: Es256KeyPair;
  /** Replace the proof outright, to exercise the DPoP failure paths. */
  proof?: string;
  omitProof?: boolean;
}

/** Performs the full /xaa/token call the Agent Runtime would make. */
export async function requestIdJag(harness: AgentOpHarness, input: ExchangeInput): Promise<Response> {
  const path = '/xaa/token';
  const iat = Math.floor(harness.now() / 1000);
  const sign = (typ: string, payload: Record<string, unknown>) => signCompactJws({
    header: { alg: 'ES256', typ, kid: harness.agentId },
    payload,
    signer: createLocalEs256Signer({ privateKey: harness.agentKeyPair.privateKey, kid: harness.agentId }),
  });
  const keyPair = input.dpopKeyPair ?? harness.dpopKeyPair;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (!input.omitProof) {
    headers.DPoP = input.proof ?? await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}${path}`, keyPair, now: harness.now });
  }
  return harness.fetch(path, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: input.subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      actor_token: await sign(ACTOR_TOKEN_TYP, { iss: harness.agentId, sub: harness.agentId, aud: HUMAN_IDP_ISSUER, iat, exp: iat + 120, jti: input.actorJti ?? randomUUID() }),
      actor_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      audience: input.audience ?? DOCS_AS_ISSUER,
      resource: input.resource ?? DOCS_API_RESOURCE,
      scope: input.scope ?? 'docs.read',
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await sign(JWT_TYP.CLIENT_ASSERTION, { iss: harness.agentId, sub: harness.agentId, aud: `${HUMAN_IDP_ISSUER}${path}`, iat, exp: iat + 120, jti: randomUUID() }),
    }).toString(),
  });
}
