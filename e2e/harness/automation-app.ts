import { webcrypto } from 'node:crypto';
import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws, type Es256KeyPair } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import createAutomationApp from '@xaa/automation-app/app';
import type { AutomationAppConfig } from '@xaa/automation-app/src/config';
import { createSessionStore } from '@xaa/automation-app/src/auth/session-store';
import { PUSH_SERVICE_ACCOUNT_PREFIX } from '@xaa/automation-app/src/activity/oidc-verify';
import type { Fetcher } from './oauth-flow.js';

export const AUTOMATION_APP_BASE = 'https://automation-app.test';
export const AUTHORIZATION_BASE = 'https://authorization.test';
export const PROVISIONER_BASE = 'https://provisioner.test';
export const LIFECYCLE_BASE = 'https://lifecycle.test';

export interface AutomationHarness {
  fetch: Fetcher;
  documents: DocumentStore;
  /** Scoped as the Runtime, for the checkpoint this app only reads. */
  runtimeStore: DocumentStore;
  /** Scoped as the Provisioner, for the registration this app only reads. */
  provisionerStore: DocumentStore;
  humanSubject: string;
  upstream: Array<{ url: string; init: RequestInit }>;
  auditLines: string[];
}

const ISSUER = 'https://human-idp.test';
let idpKey: Es256KeyPair | undefined;

async function accessToken(subject: string, audience: string): Promise<string> {
  idpKey ??= await generateEs256KeyPair();
  const issuedAt = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: 'at+jwt', kid: 'idp-1' },
    payload: {
      iss: ISSUER, sub: subject, aud: audience,
      scope: 'workdef:submit agent:provision agent:revoke', iat: issuedAt, exp: issuedAt + 3600,
    },
    signer: createLocalEs256Signer({ privateKey: idpKey.privateKey, kid: 'idp-1' }),
  });
}

/**
 * The Automation App wired for an end-to-end run: a real session, a real Firestore
 * double, and a transport that hands each upstream call to whichever app is standing
 * in for it. Nothing about the app under test is stubbed.
 */
export async function startAutomationAppHarness(options: {
  humanSubject?: string;
  shared?: ReturnType<typeof createFirestoreDouble>;
  upstream?: (url: string, init: RequestInit) => Response | Promise<Response>;
} = {}): Promise<AutomationHarness> {
  const humanSubject = options.humanSubject ?? 'testuser';
  const firestore = options.shared ?? createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'automation-app');
  const runtimeStore = createFirestoreDocumentStore(firestore, 'agent-runtime');
  const provisionerStore = createFirestoreDocumentStore(firestore, 'provisioner');
  const sessions = createSessionStore(documents);

  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const dpopJwk = Object.fromEntries(Object.entries(exported).filter(([key]) => key !== 'key_ops' && key !== 'ext'));

  const session = await sessions.create({
    human_subject: humanSubject,
    id_token: await accessToken(humanSubject, 'automation-app'),
    access_tokens: {
      'automation-app': await accessToken(humanSubject, 'automation-app'),
      'authorization-platform': await accessToken(humanSubject, 'authorization-platform'),
      'agent-provisioner': await accessToken(humanSubject, 'agent-provisioner'),
      'lifecycle-manager': await accessToken(humanSubject, 'lifecycle-manager'),
    },
    dpop_private_jwk: dpopJwk,
  });

  const config: AutomationAppConfig = {
    port: 8080, issuer: ISSUER, clientId: 'automation-app',
    clientSecret: 'test-automation-app-secret', publicBaseUrl: AUTOMATION_APP_BASE,
    authorizationPlatformUrl: AUTHORIZATION_BASE, agentProvisionerUrl: PROVISIONER_BASE,
    lifecycleManagerUrl: LIFECYCLE_BASE, docsApiUrl: 'https://resource-docs-api.test',
    activityTopic: 'agent-activity-stream', defaultAgentLifetimeHours: 1,
    vertexModel: 'test-model', vertexMode: 'fake', storeMode: 'emulator',
  };

  const upstream: Array<{ url: string; init: RequestInit }> = [];
  const auditLines: string[] = [];
  const app = createAutomationApp({
    config,
    documents,
    sessions,
    verifyAccessToken: async (token) =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
    verifyIdToken: async (token) =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
    auditWrite: (line) => auditLines.push(line),
    fetchImpl: (async (url: string | URL | Request, init: RequestInit = {}) => {
      const target = String(url);
      upstream.push({ url: target, init });
      if (options.upstream) return await options.upstream(target, init);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });

  const cookie = `xaa_session=${session.session_id}`;
  return {
    documents, runtimeStore, provisionerStore, humanSubject, upstream, auditLines,
    fetch: async (path, init = {}) => app.fetch(new Request(new URL(path, AUTOMATION_APP_BASE), {
      ...init,
      headers: { cookie, ...(init.headers as Record<string, string> | undefined) },
    })),
  };
}

/**
 * A Pub/Sub push delivery's own OIDC identity: an RS256 token, signed with a throwaway
 * key and verified the way `verifyGoogleServiceIdentity` verifies the real one — against
 * a JWKS served over `fetchImpl` rather than https://www.googleapis.com. Nothing here
 * reaches Google; the point is to exercise `/internal/activity/push` the way Pub/Sub's
 * own delivery would authenticate it.
 */
export async function mintPushIdentity(options: { audience: string; email?: string }): Promise<{
  token: string;
  jwks: { keys: Array<JsonWebKey & { kid: string; alg: 'RS256' }> };
}> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const kid = 'push-testkey';
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode({
    iss: 'https://accounts.google.com',
    aud: options.audience,
    email: options.email ?? `${PUSH_SERVICE_ACCOUNT_PREFIX}xaa-test.iam.gserviceaccount.com`,
    iat: now,
    exp: now + 300,
  })}`;
  const signature = await webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signingInput),
  );
  return {
    token: `${signingInput}.${Buffer.from(signature).toString('base64url')}`,
    jwks: { keys: [{ ...publicJwk, kid, alg: 'RS256' }] },
  };
}
