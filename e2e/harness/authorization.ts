import { createDpopProof, generateEs256KeyPair, InMemoryJtiStore, type Es256KeyPair } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createAuthorization from '@xaa/authorization/app';
import type { AuthorizationConfig } from '@xaa/authorization/src/config';
import type { VertexClient } from '@xaa/authorization/src/ai/authorization-ai';
import { createFakeVertex, seedAuthorizationData, type FakeModel } from '@xaa/authorization/src/testing/fixtures';
import { authorize, tokenRequest, type Fetcher } from './oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, startHumanIdp } from './human-idp.js';

export const AUTHZ_BASE = 'https://authorization.test';

export interface AuthorizationHarness {
  fetch: Fetcher;
  documents: DocumentStore;
  /** Scoped as the Provisioner, for the agents this platform only reads. */
  provisionerStore: DocumentStore;
  /** Scoped as the seed Job, which is the only writer of the permission tables. */
  seedStore: DocumentStore;
  logs: string[];
  activity: Array<Record<string, unknown>>;
  /** Every Re-Provisioning this platform asked Lifecycle Manager for, in order. */
  reprovisions: Array<{ agentId: string; effectiveCapabilities: string[]; workDefinitionId: string; reason: string }>;
}

export async function startAuthorization(options: {
  /** The Human IdP signing key, so Access Tokens verify. */
  idpPublicJwk: JsonWebKey;
  humanPermissions: string[];
  model?: FakeModel;
  vertex?: VertexClient;
  shared?: ReturnType<typeof createFirestoreDouble>;
  /** Makes every Activity publish fail, to show the decision survives it (RULE-55). */
  failActivityPublish?: boolean;
}): Promise<AuthorizationHarness> {
  const firestore = options.shared ?? createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  const provisionerStore = createFirestoreDocumentStore(firestore, 'provisioner');
  const seedStore = createFirestoreDocumentStore(firestore, 'seed');
  await seedAuthorizationData(documents, options.humanPermissions, seedStore);

  const logs: string[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const reprovisions: AuthorizationHarness['reprovisions'] = [];
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
    publishActivity: async (event) => {
      if (options.failActivityPublish) throw new Error('topic unavailable');
      activity.push(event);
    },
    // Lifecycle Manager's side of the call is its own test's business; what this one
    // has to see is whether the ask happened at all, and with which capabilities.
    requestReprovision: async (request) => { reprovisions.push({ ...request }); },
  });

  return {
    documents, provisionerStore, seedStore, logs, activity, reprovisions,
    fetch: async (path, init) => app.fetch(new Request(new URL(path, AUTHZ_BASE), init)),
  };
}

/**
 * A real Access Token for the Authorization Platform, minted by Human IdP, with the
 * key it is bound to. The specs that follow are about what the platform decides, so
 * the login is done once here rather than in each of them.
 */
export async function controlPlaneGrant(scope = 'openid workdef:submit'): Promise<{ token: string; keyPair: Es256KeyPair }> {
  const idp = await startHumanIdp();
  const keyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope, issuer: HUMAN_IDP_ISSUER,
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  return { token: (await response.json() as { access_token: string }).access_token, keyPair };
}

/** One business work request, submitted the way Automation App submits it. */
export async function submitWorkRequest(input: {
  authz: AuthorizationHarness;
  grant: { token: string; keyPair: Es256KeyPair };
  body: unknown;
  path?: string;
}): Promise<Response> {
  const path = input.path ?? '/v1/authorization/decisions';
  return input.authz.fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `DPoP ${input.grant.token}`,
      DPoP: await createDpopProof({
        method: 'POST', url: `${AUTHZ_BASE}${path}`, keyPair: input.grant.keyPair, accessToken: input.grant.token,
      }),
    },
    body: JSON.stringify(input.body),
  });
}
