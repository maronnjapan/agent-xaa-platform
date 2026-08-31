import { InMemoryJtiStore } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createAuthorization from '@xaa/authorization/app';
import type { AuthorizationConfig } from '@xaa/authorization/src/config';
import type { VertexClient } from '@xaa/authorization/src/ai/authorization-ai';
import { createFakeVertex, seedAuthorizationData, type FakeModel } from '@xaa/authorization/src/testing/fixtures';
import type { Fetcher } from './oauth-flow.js';
import { HUMAN_IDP_ISSUER } from './human-idp.js';

export const AUTHZ_BASE = 'https://authorization.test';

export interface AuthorizationHarness {
  fetch: Fetcher;
  documents: DocumentStore;
  logs: string[];
  activity: Array<Record<string, unknown>>;
}

export async function startAuthorization(options: {
  /** The Human IdP signing key, so Access Tokens verify. */
  idpPublicJwk: JsonWebKey;
  humanPermissions: string[];
  model?: FakeModel;
  vertex?: VertexClient;
}): Promise<AuthorizationHarness> {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(documents, options.humanPermissions, createFirestoreDocumentStore(firestore, 'seed'));

  const logs: string[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const config: AuthorizationConfig = {
    port: 8080, issuer: HUMAN_IDP_ISSUER, jwksUrl: 'https://storage.test/xaa-jwks/jwks.json',
    authzAudience: 'authorization-platform', authzPublicBaseUrl: AUTHZ_BASE,
    projectId: 'xaa-test', region: 'asia-northeast1',
    storeMode: 'emulator', pubsubMode: 'inproc', vertexMode: 'fake',
    vertexModel: 'gemini-2.5-flash', vertexLocation: 'us-central1',
    dpopIatSkewSeconds: 60, dpopJtiTtlSeconds: 120,
    lifecycleManagerUrl: 'https://lifecycle.test', activityTopic: 'agent-activity-stream',
    taxonomyVersion: 'v1', agentMaxLifetimeSeconds: 86_400,
  };

  const app = createAuthorization({
    config, documents,
    vertex: options.vertex ?? createFakeVertex(options.model ?? {}),
    jtiStore: new InMemoryJtiStore(),
    // The Access Token is signed by Human IdP's SSO key, so the JWK Set the guard
    // fetches is that key.
    fetchImpl: (async () => Response.json({ keys: [{ ...options.idpPublicJwk, kid: 'idp-testkey', alg: 'RS256', use: 'sig' }] })) as unknown as typeof fetch,
    logger: createLogger('authorization', 'policy_engine', (line) => { logs.push(line); }),
    publishActivity: async (event) => { activity.push(event); },
  });

  return {
    documents, logs, activity,
    fetch: async (path, init) => app.fetch(new Request(new URL(path, AUTHZ_BASE), init)),
  };
}
