import { randomUUID } from 'node:crypto';
import {
  createDpopProof, createLocalEs256Signer, InMemoryJtiStore,
  signCompactJws, type Es256KeyPair,
} from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { createRevocationLedger, type RedeemStep } from '@xaa/resource-guard';
import createDocsAs from '@xaa/resource-docs-as/app';
import createFinanceAs from '@xaa/resource-finance-as/app';
import createDocsApi from '@xaa/resource-docs-api/app';
import createFinanceApi from '@xaa/resource-finance-api/app';
import { generateLocalSigningJwk, localSigningKey } from '@xaa/resource-docs-as/src/keys/self-bootstrap';
import type { ResourceAsEnv } from '@xaa/resource-docs-as/src/config/env';
import type { Fetcher } from './oauth-flow.js';
import { DOCS_AS_ISSUER, DOCS_API_RESOURCE, FINANCE_AS_ISSUER, FINANCE_API_RESOURCE } from './agent-op.js';

export { DOCS_AS_ISSUER, DOCS_API_RESOURCE, FINANCE_AS_ISSUER, FINANCE_API_RESOURCE };

export interface ResourceHarness {
  as: Fetcher;
  api: Fetcher;
  documents: DocumentStore;
  seedStore: DocumentStore;
  asIssuer: string;
  resourceUri: string;
  logs: string[];
  redeemSteps: RedeemStep[];
  ledger: ReturnType<typeof createRevocationLedger>;
}

export interface StartResourceOptions {
  kind: 'docs' | 'finance';
  /** The Agent OP public JWK, so the Resource AS can verify an ID-JAG. */
  agentOpPublicJwk: JsonWebKey;
  trustedIdpIssuer: string;
  absoluteMaxAmount?: number;
  lifecycleServiceAccount?: string;
}

const KID_PREFIX = { docs: 'docs-as', finance: 'fin-as' } as const;

export async function startResource(options: StartResourceOptions): Promise<ResourceHarness> {
  const asIssuer = options.kind === 'docs' ? DOCS_AS_ISSUER : FINANCE_AS_ISSUER;
  const resourceUri = options.kind === 'docs' ? DOCS_API_RESOURCE : FINANCE_API_RESOURCE;
  // 00b: the Resource AS signs Access Tokens with RSA-2048/RS256.
  const signingKey = await localSigningKey(await generateLocalSigningJwk(), KID_PREFIX[options.kind]);

  const firestore = createFirestoreDouble();
  const apiApp = options.kind === 'docs' ? 'resource-docs-api' : 'resource-finance-api';
  const documents = createFirestoreDocumentStore(firestore, apiApp);
  const seedStore = createFirestoreDocumentStore(firestore, apiApp);
  const ledger = createRevocationLedger(documents);
  const logs: string[] = [];
  const logger = createLogger(apiApp, 'resource_api', (line) => { logs.push(line); });
  const redeemSteps: RedeemStep[] = [];
  const jtiStore = new InMemoryJtiStore();

  const env: ResourceAsEnv = {
    port: 8080, issuer: asIssuer,
    trustedIdpIssuer: options.trustedIdpIssuer,
    trustedIdpJwksUri: 'https://storage.test/xaa-jwks/jwks.json',
    accessTokenExpiresIn: 300,
    registeredScopes: options.kind === 'docs' ? ['docs.read', 'docs.write'] : ['finance.tx.read', 'finance.tx.write'],
    signingKeyBucket: 'xaa-keys', signingKeyObject: 'signing/current.json',
    signingKeyKmsKey: `projects/p/locations/l/keyRings/resource-as-signing/cryptoKeys/${options.kind}`,
    jwksBucket: 'xaa-jwks', jwksKeyPrefix: KID_PREFIX[options.kind],
    signerMode: 'local', storeMode: 'emulator', resourceUri, asKind: options.kind,
  };

  // The Resource AS pulls the trusted JWK Set over HTTP; the double answers with the
  // Agent OP key under the kid that OP actually signs with. Both `op-shared-` and
  // `idjag-` are accepted there, because a Dedicated OP's grant is the shared
  // issuer's grant (docs 05 §5).
  const fetchImpl = (async () => Response.json({
    keys: [{
      ...options.agentOpPublicJwk,
      kid: (options.agentOpPublicJwk as { kid?: string }).kid ?? 'op-shared-1',
      alg: 'ES256', use: 'sig',
    }],
  })) as unknown as typeof fetch;

  const asApp = options.kind === 'docs'
    ? createDocsAs({ env, signingKey, jtiStore, fetchImpl, logger, recordStep: (step) => redeemSteps.push(step), isActorRevoked: (urn) => ledger.isActorRevoked(urn) })
    : createFinanceAs({ env, signingKey, jtiStore, fetchImpl, logger, recordStep: (step) => redeemSteps.push(step), isActorRevoked: (urn) => ledger.isActorRevoked(urn), requireIsolationLevel: 'full_isolation' });

  // The Resource API verifies Access Tokens against the AS's own published key.
  const apiJwks = (async () => Response.json({ keys: [signingKey.publicJwk] })) as unknown as typeof fetch;
  const verifier = { async verify(authorization: string | undefined) { return authorization?.replace(/^Bearer /, '') ?? null; } };
  const shared = {
    documents, asIssuer, resourceUri, jwksUrl: 'https://storage.test/xaa-jwks/jwks.json',
    jtiStore: new InMemoryJtiStore(), fetchImpl: apiJwks, logger,
    serviceIdentity: verifier, lifecycleServiceAccount: options.lifecycleServiceAccount ?? 'sa-lifecycle@xaa-test.iam.gserviceaccount.com',
    // One ledger for the app and the test, matching the single-process production
    // shape; otherwise a revocation made here would only surface after the cache TTL.
    revocationLedger: ledger,
  };
  const apiApplication = options.kind === 'docs'
    ? createDocsApi(shared)
    : createFinanceApi({ ...shared, absoluteMaxAmount: options.absoluteMaxAmount ?? 1_000_000 });

  return {
    as: async (path, init) => asApp.fetch(new Request(new URL(path, asIssuer), init)),
    api: async (path, init) => apiApplication.fetch(new Request(new URL(path, resourceUri), init)),
    documents, seedStore, asIssuer, resourceUri, logs, redeemSteps, ledger,
  };
}

/** Redeems an ID-JAG for an Access Token, presenting the proof the grant is bound to. */
export async function redeemForAccessToken(harness: ResourceHarness, options: {
  idJag: string;
  keyPair: Es256KeyPair;
  scope?: string;
  omitProof?: boolean;
  proofKeyPair?: Es256KeyPair;
}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (!options.omitProof) {
    headers.DPoP = await createDpopProof({
      method: 'POST', url: `${harness.asIssuer}/token`, keyPair: options.proofKeyPair ?? options.keyPair,
    });
  }
  return harness.as('/token', {
    method: 'POST', headers,
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: options.idJag,
      client_id: 'agent-platform',
      ...(options.scope ? { scope: options.scope } : {}),
    }).toString(),
  });
}

/** Calls a Resource API with the DPoP-bound Access Token and a matching proof. */
export async function callResource(harness: ResourceHarness, options: {
  method: string;
  path: string;
  accessToken: string;
  keyPair: Es256KeyPair;
  body?: unknown;
  toolId?: string;
  omitProof?: boolean;
  proofKeyPair?: Es256KeyPair;
  proof?: string;
}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `DPoP ${options.accessToken}` };
  if (options.toolId) headers['X-XAA-Tool-Id'] = options.toolId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!options.omitProof) {
    headers.DPoP = options.proof ?? await createDpopProof({
      method: options.method, url: `${harness.resourceUri}${options.path.split('?')[0]}`,
      keyPair: options.proofKeyPair ?? options.keyPair, accessToken: options.accessToken,
    });
  }
  return harness.api(options.path, {
    method: options.method, headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

export async function seedDocument(harness: ResourceHarness, owner: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const documentId = `doc_${randomUUID()}`;
  await harness.seedStore.set('documents', documentId, {
    document_id: documentId, owner_subject: owner, type: 'daily_report', title: 'seeded',
    body: 'body', occurred_at: new Date().toISOString(), metadata: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1, ...overrides,
  });
  return documentId;
}

export async function seedPayment(harness: ResourceHarness, requester: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const paymentId = `pay_${randomUUID()}`;
  await harness.seedStore.set('payments', paymentId, {
    payment_id: paymentId, requester_subject: requester, amount: 1000, currency: 'JPY',
    counterparty: 'ACME', status: 'pending_approval', memo: 'seeded',
    approved_by: null, approved_by_agent: null, approved_at: null,
    created_at: new Date().toISOString(), ...overrides,
  });
  return paymentId;
}

export function signForTest(keyPair: Es256KeyPair, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  return signCompactJws({
    header: header as never, payload,
    signer: createLocalEs256Signer({ privateKey: keyPair.privateKey, kid: String(header.kid ?? '') }),
  });
}
