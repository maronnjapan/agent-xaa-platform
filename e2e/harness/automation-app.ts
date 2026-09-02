import { randomUUID, webcrypto } from 'node:crypto';
import {
  createLocalEs256Signer, generateEs256KeyPair, jwkThumbprint, signCompactJws, type Es256KeyPair,
} from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import createAutomationApp from '@xaa/automation-app/app';
import type { AutomationAppConfig } from '@xaa/automation-app/src/config';
import { createSessionStore } from '@xaa/automation-app/src/auth/session-store';
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
/** The kid the other harnesses publish for the Human IdP signing key. */
const IDP_KID = 'idp-testkey';
let idpKey: Es256KeyPair | undefined;

async function signingKey(): Promise<Es256KeyPair> {
  idpKey ??= await generateEs256KeyPair();
  return idpKey;
}

/**
 * The public half of the key these session tokens are signed with, so a real Control
 * Plane app can be stood up next to this harness and verify them.
 */
export async function automationIdpPublicJwk(): Promise<JsonWebKey> {
  return (await signingKey()).publicJwk as unknown as JsonWebKey;
}

/**
 * An Access Token as the Human IdP issues one: DPoP-bound through `cnf.jkt`, with a
 * `jti` the receiving app records. Both are required by the Control Plane guard, so a
 * token without them is not a realistic stand-in for the real thing.
 */
async function accessToken(subject: string, audience: string, jkt: string): Promise<string> {
  const key = await signingKey();
  const issuedAt = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: 'at+jwt', kid: IDP_KID },
    payload: {
      iss: ISSUER, sub: subject, aud: audience, jti: randomUUID(), cnf: { jkt },
      scope: 'workdef:submit agent:provision agent:revoke', iat: issuedAt, exp: issuedAt + 3600,
    },
    signer: createLocalEs256Signer({ privateKey: key.privateKey, kid: IDP_KID }),
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
  // The session key is what every proof is made with, so the tokens are bound to it.
  const jkt = await jwkThumbprint({ kty: 'EC', crv: 'P-256', x: dpopJwk.x as string, y: dpopJwk.y as string });

  const session = await sessions.create({
    human_subject: humanSubject,
    id_token: await accessToken(humanSubject, 'automation-app', jkt),
    access_tokens: {
      'automation-app': await accessToken(humanSubject, 'automation-app', jkt),
      'authorization-platform': await accessToken(humanSubject, 'authorization-platform', jkt),
      'agent-provisioner': await accessToken(humanSubject, 'agent-provisioner', jkt),
      'lifecycle-manager': await accessToken(humanSubject, 'lifecycle-manager', jkt),
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
